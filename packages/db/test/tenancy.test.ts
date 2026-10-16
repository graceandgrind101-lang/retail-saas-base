import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { sql } from "drizzle-orm";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { INDUSTRIES, RESERVED_TENANT_SLUGS, ROLE_TEMPLATE_PERMISSIONS } from "@retail/core";
import { TenantProvisioningError, provisionTenant } from "../src/tenants";
import { createTenantDb, type TenantDb } from "../src/rls";
import { getEnabledModules, getMyTenant, isReadOnlyStatus, isShopReadOnlyError } from "../src/tenant-info";
import { PG, adminSql, appSql, appUrl, createTenant, expectPgError, newId } from "./helpers";
import { createSecuredTable, dropTables } from "./probe-tables";

const admin: Sql = adminSql(4);
let db: TenantDb;

await dropTables(admin, "tenancy_probe");
await createSecuredTable(admin, "tenancy_probe", "label text");

beforeAll(() => {
  db = createTenantDb(appUrl(), { max: 4 });
});
afterAll(async () => {
  await dropTables(admin, "tenancy_probe");
  await db.close();
  await admin.end();
});

const suffix = () => randomBytes(4).toString("hex");
const newTenant = (prefix: string) => createTenant(admin, `${prefix}-${suffix()}`);

// ── platform tables ─────────────────────────────────────────────────────────
describe("platform.tenant_modules", () => {
  it("enables a module by default and accepts well-formed keys", async () => {
    const tenant = await newTenant("mod-ok");
    await admin`insert into platform.tenant_modules (tenant_id, module_key) values (${tenant}, 'pos')`;
    const [row] = await admin<{ enabled: boolean }[]>`select enabled from platform.tenant_modules where tenant_id = ${tenant}`;
    expect(row?.enabled).toBe(true);
  });

  it.each(["", "POS", "po s", "pos-2", "1pos", "pos.x", "_pos"])("rejects the malformed key %j", async (key) => {
    const tenant = await newTenant("mod-bad");
    await expectPgError(
      Promise.resolve(admin`insert into platform.tenant_modules (tenant_id, module_key) values (${tenant}, ${key})`),
      PG.checkViolation,
    );
  });

  it("holds one row per module per shop", async () => {
    const tenant = await newTenant("mod-dup");
    await admin`insert into platform.tenant_modules (tenant_id, module_key) values (${tenant}, 'pos')`;
    await expectPgError(
      Promise.resolve(admin`insert into platform.tenant_modules (tenant_id, module_key) values (${tenant}, 'pos')`),
      PG.uniqueViolation,
    );
  });

  it("must belong to a real shop", async () => {
    await expectPgError(
      Promise.resolve(admin`insert into platform.tenant_modules (tenant_id, module_key) values (${newId()}, 'pos')`),
      PG.foreignKeyViolation,
    );
  });
});

describe("platform.setting_policies", () => {
  const policy = (tenant: string | null, key: string, state = "locked") =>
    Promise.resolve(admin`insert into platform.setting_policies (id, tenant_id, key, state) values (${newId()}, ${tenant}, ${key}, ${state})`);

  it("allows a platform default and a per-shop override for the same key", async () => {
    const tenant = await newTenant("pol-ok");
    const key = `security.test_${suffix()}`;
    await policy(null, key, "editable");
    await expect(policy(tenant, key, "locked")).resolves.toBeDefined();
  });

  it("allows only ONE platform default per key (a NULL tenant does not count as different)", async () => {
    const key = `security.dup_${suffix()}`;
    await policy(null, key);
    await expectPgError(policy(null, key), PG.uniqueViolation);
  });

  it("allows one row per shop per key", async () => {
    const tenant = await newTenant("pol-dup");
    const key = `security.dup_${suffix()}`;
    await policy(tenant, key);
    await expectPgError(policy(tenant, key), PG.uniqueViolation);
  });

  it.each(["", "nodot", "Bad.Key", "a.", ".a", "a b.c", "a..b"])("rejects the malformed key %j", async (key) => {
    await expectPgError(policy(null, key), PG.checkViolation);
  });

  it("only knows editable, locked and hidden", async () => {
    await expectPgError(policy(null, `security.x_${suffix()}`, "open"), "22P02");
  });
});

describe("a shop's session cannot reach platform tables at all", () => {
  it.each(["platform.tenants", "platform.tenant_modules", "platform.setting_policies"])("%s is closed", async (table) => {
    const app = appSql(1);
    try {
      await expectPgError(
        Promise.resolve(
          app.begin(async (tx) => {
            await tx`set local role authenticated`;
            return tx.unsafe(`select * from ${table}`);
          }),
        ),
        PG.permissionDenied,
      );
    } finally {
      await app.end();
    }
  });
});

// ── branches ────────────────────────────────────────────────────────────────
describe("app.branches", () => {
  const addBranch = (tenant: string, over: { name?: unknown; isDefault?: boolean; archived?: boolean } = {}) => {
    const id = newId();
    return Promise.resolve(
      admin`insert into app.branches (id, tenant_id, name, is_default, archived_at)
            values (${id}, ${tenant}, ${admin.json((over.name ?? { en: "Branch" }) as never)}, ${over.isDefault ?? false},
                    ${over.archived ? new Date() : null})`,
    ).then(() => id);
  };

  it.each([
    ["an empty object", {}],
    ["a plain string", "Main"],
    ["an array", ["Main"]],
  ])("rejects a name that is %s", async (_label, name) => {
    const tenant = await newTenant("br-name");
    await expectPgError(addBranch(tenant, { name }), PG.checkViolation);
  });

  it("accepts a name in Amharic only", async () => {
    const tenant = await newTenant("br-am");
    await expect(addBranch(tenant, { name: { am: "ዋና ቅርንጫፍ" } })).resolves.toBeDefined();
  });

  it("allows only one default branch per shop, but every shop may have its own", async () => {
    const a = await newTenant("br-def-a");
    const b = await newTenant("br-def-b");
    await addBranch(a, { isDefault: true });
    await expectPgError(addBranch(a, { isDefault: true }), PG.uniqueViolation);
    await expect(addBranch(a, { isDefault: false })).resolves.toBeDefined();
    await expect(addBranch(b, { isDefault: true })).resolves.toBeDefined();
  });

  it("never lets the default branch be archived, so a shop always has somewhere to sell", async () => {
    const tenant = await newTenant("br-arch");
    await expectPgError(addBranch(tenant, { isDefault: true, archived: true }), PG.checkViolation);
    const id = await addBranch(tenant, { isDefault: true });
    await expectPgError(Promise.resolve(admin`update app.branches set archived_at = now() where id = ${id}`), PG.checkViolation);
  });

  it("lets an ordinary branch be archived and the default be renamed", async () => {
    const tenant = await newTenant("br-ok");
    const def = await addBranch(tenant, { isDefault: true });
    const other = await addBranch(tenant);
    await admin`update app.branches set archived_at = now() where id = ${other}`;
    await admin`update app.branches set name = ${admin.json({ en: "Renamed" })} where id = ${def}`;
    const [row] = await admin<{ name: { en: string } }[]>`select name from app.branches where id = ${def}`;
    expect(row?.name.en).toBe("Renamed");
  });

  it("a shop's own session can manage its branches and sees only its own", async () => {
    const a = await newTenant("br-rls-a");
    const b = await newTenant("br-rls-b");
    await addBranch(b, { isDefault: true });
    const id = newId();
    await db.rls({ tenantId: a }, (tx) =>
      tx.execute(sql`insert into app.branches (id, tenant_id, name, is_default) values (${id}, ${a}, '{"en": "Mine"}'::jsonb, true)`), { write: true });
    const seen = await db.rls({ tenantId: a }, (tx) => tx.execute<{ id: string }>(sql`select id from app.branches`));
    expect(seen.map((r) => r.id)).toEqual([id]);
  });
});

// ── what a shop may know about itself ───────────────────────────────────────
describe("app.my_tenant() and app.my_modules()", () => {
  it("return the shop's own details and enabled modules", async () => {
    const slug = `self-${suffix()}`;
    const { tenantId } = await provisionTenant(admin, { slug, displayName: { en: "Self Shop", am: "ሱቅ" }, industry: "electronics", planKey: "pro" });
    const result = await db.rls({ tenantId }, async (tx) => ({ me: await getMyTenant(tx), modules: await getEnabledModules(tx) }));
    expect(result.me).toMatchObject({
      id: tenantId, slug, status: "pilot", industry: "electronics", planKey: "pro",
      timezone: "Africa/Addis_Ababa", currency: "ETB", displayName: { en: "Self Shop", am: "ሱቅ" },
    });
    expect(result.modules).toEqual(expect.arrayContaining(["pos", "inventory", "payments", "serials"]));
  });

  it("do not expose the legal name or tax id", async () => {
    const { tenantId } = await provisionTenant(admin, {
      slug: `priv-${suffix()}`, displayName: { en: "Priv" }, industry: "other", planKey: "pro", legalName: "Secret PLC", tin: "0001234567",
    });
    const rows = await db.rls({ tenantId }, (tx) => tx.execute(sql`select * from app.my_tenant()`));
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(["currency", "display_name", "id", "industry", "plan_key", "slug", "status", "timezone"]);
    expect(JSON.stringify(rows)).not.toContain("Secret PLC");
    expect(JSON.stringify(rows)).not.toContain("0001234567");
  });

  it("show a shop only its own modules, never another's, and skip disabled ones", async () => {
    const a = (await provisionTenant(admin, { slug: `ma-${suffix()}`, displayName: { en: "A" }, industry: "other", planKey: "pro", modules: ["pos", "reports"] })).tenantId;
    const b = (await provisionTenant(admin, { slug: `mb-${suffix()}`, displayName: { en: "B" }, industry: "other", planKey: "pro", modules: ["pos", "dube", "serials"] })).tenantId;
    await admin`update platform.tenant_modules set enabled = false where tenant_id = ${b} and module_key = 'dube'`;
    expect(await db.rls({ tenantId: a }, (tx) => getEnabledModules(tx))).toEqual(["pos", "reports"]);
    expect(await db.rls({ tenantId: b }, (tx) => getEnabledModules(tx))).toEqual(["pos", "serials"]);
  });

  it("ignore a stored key the code does not know yet", async () => {
    const { tenantId } = await provisionTenant(admin, { slug: `unk-${suffix()}`, displayName: { en: "U" }, industry: "other", planKey: "pro", modules: ["pos"] });
    await admin`insert into platform.tenant_modules (tenant_id, module_key) values (${tenantId}, 'future_module')`;
    expect(await db.rls({ tenantId }, (tx) => getEnabledModules(tx))).toEqual(["pos"]);
  });

  it("return nothing without a tenant context", async () => {
    const app = appSql(1);
    try {
      const [mine, modules] = await app.begin(async (tx) => {
        await tx`set local role authenticated`;
        return [await tx`select * from app.my_tenant()`, await tx`select app.my_modules()`] as const;
      });
      expect(mine).toHaveLength(0);
      expect(modules).toHaveLength(0);
    } finally {
      await app.end();
    }
  });
});

// ── paused and closed shops ─────────────────────────────────────────────────
describe("a paused or closed shop is read-only (PLAN.md §7.16: never delete, just stop writes)", () => {
  async function shopWithRow(status: string) {
    const tenantId = (await provisionTenant(admin, { slug: `ro-${suffix()}`, displayName: { en: "RO" }, industry: "other", planKey: "pro" })).tenantId;
    const rowId = newId();
    await admin`insert into app.tenancy_probe (id, tenant_id, label) values (${rowId}, ${tenantId}, 'original')`;
    await admin`update platform.tenants set status = ${status} where id = ${tenantId}`;
    return { tenantId, rowId };
  }
  const attempt = (tenantId: string, statement: ReturnType<typeof sql>) => db.rls({ tenantId }, (tx) => tx.execute(statement), { write: true });

  it.each(["paused", "closed"])("a %s shop can still READ its data", async (status) => {
    const { tenantId, rowId } = await shopWithRow(status);
    const rows = await db.rls({ tenantId }, (tx) => tx.execute<{ id: string }>(sql`select id from app.tenancy_probe`));
    expect(rows.map((r) => r.id)).toEqual([rowId]);
    const history = await db.rls({ tenantId }, (tx) => tx.execute(sql`select count(*)::int as n from audit.log`));
    expect(Number((history[0] as { n: number }).n)).toBeGreaterThan(0);
  });

  it.each(["paused", "closed"])("a %s shop cannot insert, update or delete anything", async (status) => {
    const { tenantId, rowId } = await shopWithRow(status);
    for (const statement of [
      sql`insert into app.tenancy_probe (id, tenant_id, label) values (${newId()}, ${tenantId}, 'new')`,
      sql`update app.tenancy_probe set label = 'changed' where id = ${rowId}`,
      sql`delete from app.tenancy_probe where id = ${rowId}`,
      sql`update app.tenancy_probe set label = 'x' where false`, // even a change that would touch no rows
      sql`insert into app.branches (id, tenant_id, name) values (${newId()}, ${tenantId}, '{"en": "x"}'::jsonb)`,
    ]) {
      await expectPgError(attempt(tenantId, statement), "25006");
    }
    const [row] = await admin<{ label: string }[]>`select label from app.tenancy_probe where id = ${rowId}`;
    expect(row?.label).toBe("original");
  });

  it("the helper recognises the error, so the app can say 'your account is paused'", async () => {
    const { tenantId } = await shopWithRow("paused");
    const failure = await attempt(tenantId, sql`delete from app.tenancy_probe`).then(() => undefined, (e: unknown) => e);
    expect(isShopReadOnlyError(failure)).toBe(true);
    expect(isShopReadOnlyError(new Error("other"))).toBe(false);
    expect(isShopReadOnlyError(null)).toBe(false);
    expect(isReadOnlyStatus("paused") && isReadOnlyStatus("closed")).toBe(true);
    expect(["pilot", "trial", "active", "past_due"].some((s) => isReadOnlyStatus(s as never))).toBe(false);
  });

  it.each(["pilot", "trial", "active", "past_due"])("a %s shop can still write (past_due is a warning, not a lock)", async (status) => {
    const { tenantId, rowId } = await shopWithRow(status);
    await attempt(tenantId, sql`update app.tenancy_probe set label = 'changed' where id = ${rowId}`);
    const [row] = await admin<{ label: string }[]>`select label from app.tenancy_probe where id = ${rowId}`;
    expect(row?.label).toBe("changed");
  });

  it("platform code with no shop context can still fix a paused shop (support, billing)", async () => {
    const { tenantId, rowId } = await shopWithRow("paused");
    await admin`update app.tenancy_probe set label = 'fixed by support' where id = ${rowId}`;
    const [row] = await admin<{ label: string }[]>`select label from app.tenancy_probe where id = ${rowId}`;
    expect(row?.label).toBe("fixed by support");
    expect(tenantId).toBeTruthy();
  });

  it("writes work again the moment the shop is reactivated", async () => {
    const { tenantId, rowId } = await shopWithRow("paused");
    await expectPgError(attempt(tenantId, sql`delete from app.tenancy_probe where id = ${rowId}`), "25006");
    await admin`update platform.tenants set status = 'active' where id = ${tenantId}`;
    await attempt(tenantId, sql`update app.tenancy_probe set label = 'back' where id = ${rowId}`);
    const [row] = await admin<{ label: string }[]>`select label from app.tenancy_probe where id = ${rowId}`;
    expect(row?.label).toBe("back");
  });

  it("pausing one shop does not affect another", async () => {
    const paused = await shopWithRow("paused");
    const active = await shopWithRow("active");
    await expectPgError(attempt(paused.tenantId, sql`delete from app.tenancy_probe`), "25006");
    await attempt(active.tenantId, sql`update app.tenancy_probe set label = 'ok' where id = ${active.rowId}`);
  });
});

// ── creating a shop ─────────────────────────────────────────────────────────
describe("provisionTenant", () => {
  it("creates the shop, its modules and one default branch, and records who made it", async () => {
    const slug = `new-${suffix()}`;
    const result = await provisionTenant(admin, {
      slug, displayName: { en: "Nati Mobile", am: "ናቲ ሞባይል" }, industry: "electronics", planKey: "pro", legalName: "Nati PLC", tin: "0009876543",
    });
    expect(result).toMatchObject({ slug });

    const [tenant] = await admin`select * from platform.tenants where id = ${result.tenantId}`;
    expect(tenant).toMatchObject({ slug, status: "pilot", industry: "electronics", plan_key: "pro", legal_name: "Nati PLC", tin: "0009876543" });
    expect(tenant?.display_name).toEqual({ en: "Nati Mobile", am: "ናቲ ሞባይል" });

    const modules = await admin<{ module_key: string; enabled: boolean }[]>`select module_key, enabled from platform.tenant_modules where tenant_id = ${result.tenantId} order by module_key`;
    expect(modules.map((m) => m.module_key)).toEqual([...result.modules].sort());
    expect(modules.every((m) => m.enabled)).toBe(true);
    expect(result.modules).toContain("serials");

    const branches = await admin<{ id: string; is_default: boolean; name: { en: string; am: string } }[]>`select id, is_default, name from app.branches where tenant_id = ${result.tenantId}`;
    expect(branches).toHaveLength(1);
    expect(branches[0]).toMatchObject({ id: result.branchId, is_default: true, name: { en: "Main branch", am: "ዋና ቅርንጫፍ" } });

    const log = await admin<{ seq: number; event_key: string; actor_kind: string; after_data: Record<string, unknown> }[]>`
      select seq::int as seq, event_key, actor_kind, after_data from audit.log where tenant_id = ${result.tenantId} order by seq`;
    // the default branch, the five system roles and what their templates grant, then the creation event
    const granted = Object.values(ROLE_TEMPLATE_PERMISSIONS).reduce((n, keys) => n + keys.length, 0);
    expect(log.map((e) => e.event_key)).toEqual([...Array(6 + granted).fill("row.insert"), "tenant.created"]);
    const [grants] = await admin<{ n: number }[]>`select count(*)::int as n from app.role_permissions where tenant_id = ${result.tenantId}`;
    expect(grants?.n).toBe(granted);
    expect(log.every((e) => e.actor_kind === "system")).toBe(true);
    expect(log.at(-1)?.after_data).toMatchObject({ slug, industry: "electronics", plan: "pro", ownerInvited: false });
    const [chain] = await admin<{ ok: boolean }[]>`select ok from audit.verify_chain(${result.tenantId})`;
    expect(chain?.ok).toBe(true);
  });

  it("gives each industry its own starter modules", async () => {
    const electronics = await provisionTenant(admin, { slug: `el-${suffix()}`, displayName: { en: "E" }, industry: "electronics", planKey: "pro" });
    const market = await provisionTenant(admin, { slug: `mm-${suffix()}`, displayName: { en: "M" }, industry: "minimarket", planKey: "pro" });
    expect(electronics.modules).toContain("serials");
    expect(market.modules).not.toContain("serials");
  });

  it("honours an explicit module list and status", async () => {
    const result = await provisionTenant(admin, { slug: `cu-${suffix()}`, displayName: { en: "C" }, industry: "other", planKey: "business", modules: ["pos", "dube"], status: "trial" });
    expect(result.modules).toEqual(["pos", "dube"]);
    const [t] = await admin<{ status: string }[]>`select status from platform.tenants where id = ${result.tenantId}`;
    expect(t?.status).toBe("trial");
  });

  it("two shops are independent: neither sees the other's branches", async () => {
    const a = await provisionTenant(admin, { slug: `ia-${suffix()}`, displayName: { en: "A" }, industry: "other", planKey: "pro" });
    const b = await provisionTenant(admin, { slug: `ib-${suffix()}`, displayName: { en: "B" }, industry: "other", planKey: "pro" });
    const seenByA = await db.rls({ tenantId: a.tenantId }, (tx) => tx.execute<{ id: string }>(sql`select id from app.branches`));
    const seenByB = await db.rls({ tenantId: b.tenantId }, (tx) => tx.execute<{ id: string }>(sql`select id from app.branches`));
    expect(seenByA.map((r) => r.id)).toEqual([a.branchId]);
    expect(seenByB.map((r) => r.id)).toEqual([b.branchId]);
  });

  describe("refuses bad input, naming the problem, before anything is written", () => {
    const base = { displayName: { en: "X" }, industry: "other" as const, planKey: "pro" };
    const problemOf = (input: Parameters<typeof provisionTenant>[1]) =>
      provisionTenant(admin, input).then(() => "none", (e: unknown) => (e instanceof TenantProvisioningError ? e.problem : `other: ${String(e)}`));

    it.each(["ab", "Bad_Slug", "-x-", "x".repeat(41), ""])("slug %j", async (slug) => {
      expect(await problemOf({ ...base, slug })).toBe("invalid_slug");
    });

    it("every reserved subdomain", async () => {
      for (const slug of RESERVED_TENANT_SLUGS) expect(await problemOf({ ...base, slug })).toBe("invalid_slug");
    });

    it.each([[{}], [{ en: "" }], [{ en: "   " }], [{ am: "" }]])("name %j", async (displayName) => {
      expect(await problemOf({ ...base, slug: `nm-${suffix()}`, displayName })).toBe("invalid_name");
    });

    it("industry", async () => {
      expect(await problemOf({ ...base, slug: `in-${suffix()}`, industry: "pharmacy" as never })).toBe("invalid_industry");
    });

    it.each(["", "Pro", "pro plan", "1pro"])("plan %j", async (planKey) => {
      expect(await problemOf({ ...base, slug: `pl-${suffix()}`, planKey })).toBe("invalid_plan");
    });

    it("unknown or repeated modules", async () => {
      expect(await problemOf({ ...base, slug: `mo-${suffix()}`, modules: ["pos", "nonsense" as never] })).toBe("invalid_modules");
      expect(await problemOf({ ...base, slug: `md-${suffix()}`, modules: ["pos", "pos"] })).toBe("invalid_modules");
    });

    it("an address that is already taken", async () => {
      const slug = `tk-${suffix()}`;
      await provisionTenant(admin, { ...base, slug });
      expect(await problemOf({ ...base, slug })).toBe("slug_taken");
    });

    it("writes nothing at all for any of the above", async () => {
      const slug = `zz-${suffix()}`;
      await problemOf({ ...base, slug, modules: ["nonsense" as never] });
      await problemOf({ ...base, slug, planKey: "Bad Plan" });
      const [row] = await admin<{ n: number }[]>`select count(*)::int as n from platform.tenants where slug = ${slug}`;
      expect(row?.n).toBe(0);
    });
  });

  it("is all-or-nothing: a failure part-way through leaves no shop, modules or branch behind", async () => {
    const slug = `atomic-${suffix()}`;
    // Make the branch insert fail, which happens AFTER the shop and its modules were written.
    await admin.unsafe(`create function app.zz_fail_branch() returns trigger language plpgsql as $$ begin raise exception 'boom'; end $$`);
    await admin.unsafe("create trigger zz_fail before insert on app.branches for each row execute function app.zz_fail_branch()");
    try {
      await expect(provisionTenant(admin, { slug, displayName: { en: "A" }, industry: "electronics", planKey: "pro" })).rejects.toThrow(/boom/);
    } finally {
      await admin.unsafe("drop trigger zz_fail on app.branches");
      await admin.unsafe("drop function app.zz_fail_branch()");
    }
    const [tenants] = await admin<{ n: number }[]>`select count(*)::int as n from platform.tenants where slug = ${slug}`;
    const [modules] = await admin<{ n: number }[]>`select count(*)::int as n from platform.tenant_modules m join platform.tenants t on t.id = m.tenant_id where t.slug = ${slug}`;
    expect(tenants?.n).toBe(0);
    expect(modules?.n).toBe(0);
    await expect(provisionTenant(admin, { slug, displayName: { en: "A" }, industry: "electronics", planKey: "pro" })).resolves.toBeDefined(); // and the address is free again
  });

  it("lists every industry it supports", () => {
    expect(INDUSTRIES.length).toBeGreaterThan(0);
  });
});

// ── the command ─────────────────────────────────────────────────────────────
describe("pnpm tenant:create", () => {
  function run(args: string[], env: Record<string, string | undefined> = { DATABASE_ADMIN_URL: inject("adminUrl") }) {
    return spawnSync("pnpm", ["exec", "tsx", "src/bin/create-tenant.ts", ...args], {
      shell: true,
      encoding: "utf8",
      env: { ...process.env, DATABASE_ADMIN_URL: undefined, ...env },
    });
  }

  it("creates a shop and prints what it made", async () => {
    const slug = `cli-${suffix()}`;
    const result = run(["--slug", slug, "--name", "Natimobile", "--name-am", "ናቲ", "--industry", "electronics", "--plan", "pro"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`created shop "${slug}"`);
    expect(result.stdout).toMatch(/tenant id: [0-9a-f-]{36}/);
    expect(result.stdout).toContain("serials");
    const [row] = await admin<{ display_name: { en: string; am: string }; status: string }[]>`select display_name, status from platform.tenants where slug = ${slug}`;
    expect(row).toMatchObject({ display_name: { en: "Natimobile", am: "ናቲ" }, status: "pilot" });
  }, 60_000);

  it("takes an explicit module list and status", async () => {
    const slug = `cli2-${suffix()}`;
    const result = run(["--slug", slug, "--name", "Shop", "--industry", "other", "--plan", "business", "--status", "trial", "--modules", "pos,dube"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("modules: pos, dube");
  }, 60_000);

  it("refuses a taken address with a clear message and a failing exit code", () => {
    const slug = `cli3-${suffix()}`;
    const args = ["--slug", slug, "--name", "Shop", "--industry", "other", "--plan", "pro"];
    expect(run(args).status).toBe(0);
    const again = run(args);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("already taken");
  }, 60_000);

  it.each([
    ["a bad industry", ["--slug", "badind-x", "--name", "S", "--industry", "pharmacy", "--plan", "pro"], "--industry must be one of"],
    ["a bad status", ["--slug", "badst-x", "--name", "S", "--industry", "other", "--plan", "pro", "--status", "paused"], "--status must be"],
    ["an unknown module", ["--slug", "badmo-x", "--name", "S", "--industry", "other", "--plan", "pro", "--modules", "pos,nope"], "unknown module"],
    ["a reserved address", ["--slug", "console", "--name", "S", "--industry", "other", "--plan", "pro"], "not a valid shop address"],
    ["missing arguments", ["--slug", "only-slug"], "Usage:"],
  ])("fails clearly for %s", (_label, args, message) => {
    const result = run(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  }, 60_000);

  it("refuses to run without DATABASE_ADMIN_URL", () => {
    const result = run(["--slug", "noenv-x", "--name", "S", "--industry", "other", "--plan", "pro"], {});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DATABASE_ADMIN_URL");
  }, 60_000);
});
