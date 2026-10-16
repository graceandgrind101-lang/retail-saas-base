import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { sql } from "drizzle-orm";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { SYSTEM_ROLES, SYSTEM_ROLE_KEYS, generateInviteToken, hashInviteToken } from "@retail/core";
import {
  AlreadyMemberError,
  InviteInvalidError,
  NoShopAccessError,
  SessionEndedError,
  isSessionEndedError,
} from "../src/errors";
import { InvalidRlsContextError, createTenantDb, type RlsContext, type TenantDb } from "../src/rls";
import { acceptInvite, endMySession, listMyShops, startSession } from "../src/sign-in";
import { isShopReadOnlyError } from "../src/tenant-info";
import { createAdminDb } from "../src/admin";
import { TenantProvisioningError, provisionTenant } from "../src/tenants";
import { PG, adminSql, appUrl, createTenant, expectPgError, newId, randomLetters } from "./helpers";

const admin: Sql = adminSql(4);
let db: TenantDb;

beforeAll(() => {
  db = createTenantDb(appUrl(), { max: 6 });
});
afterAll(async () => {
  await db.close();
  await admin.end();
});

const suffix = () => randomBytes(4).toString("hex");
const account = (email = `user-${suffix()}@example.com`) => ({ authUserId: newId(), email });

async function shopWithOwnerInvite(prefix: string, ownerEmail = `owner-${suffix()}@example.com`) {
  const shop = await provisionTenant(admin, {
    slug: `${prefix}-${suffix()}`,
    displayName: { en: `Shop ${prefix}` },
    industry: "other",
    planKey: "pro",
    owner: { email: ownerEmail, displayName: "Owner Person" },
  });
  if (!shop.ownerInvite) throw new Error("expected an invitation");
  // A second owner, so tests can suspend the first (a shop can never lose its LAST owner; see permissions.test.ts).
  await admin`insert into app.staff (id, tenant_id, display_name, role_id, status)
              values (${newId()}, ${shop.tenantId}, 'Co-owner', ${shop.roleIds.owner}, 'active')`;
  return { ...shop, token: shop.ownerInvite.token, ownerEmail };
}

/** The owner follows the invitation and signs in: the full path, returning what a request needs. */
async function ownerSignedIn(prefix: string) {
  const shop = await shopWithOwnerInvite(prefix);
  const acct = account(shop.ownerEmail);
  const accepted = await db.identity(acct, (tx) => acceptInvite(tx, shop.token));
  const session = await db.identity(acct, (tx) => startSession(tx, { tenantId: accepted.tenantId, method: "password" }));
  const ctx: RlsContext = { tenantId: shop.tenantId, staffId: session.staffId, sessionId: session.sessionId };
  return { shop, acct, accepted, session, ctx };
}

const read = (ctx: RlsContext) => db.rls(ctx, (tx) => tx.execute(sql`select count(*)::int as n from app.branches`));
const write = (ctx: RlsContext) =>
  db.rls(ctx, (tx) => tx.execute(sql`update app.branches set phone = ${randomBytes(3).toString("hex")} where is_default`), { write: true });

// ── a new shop has roles and (optionally) an invited owner ──────────────────
describe("creating a shop: roles and the owner's invitation", () => {
  it("creates the five system roles with names in both languages", async () => {
    const shop = await provisionTenant(admin, { slug: `roles-${suffix()}`, displayName: { en: "R" }, industry: "other", planKey: "pro" });
    const rows = await admin<{ id: string; key: string; is_system: boolean; template_key: string; name: Record<string, string> }[]>`
      select id, key, is_system, template_key, name from app.roles where tenant_id = ${shop.tenantId} order by key`;
    expect(rows.map((r) => r.key).sort()).toEqual([...SYSTEM_ROLE_KEYS].sort());
    for (const row of rows) {
      expect(row.is_system).toBe(true);
      expect(row.template_key).toBe(row.key);
      expect(row.name).toEqual(SYSTEM_ROLES[row.key as keyof typeof SYSTEM_ROLES].name);
      expect(shop.roleIds[row.key as keyof typeof shop.roleIds]).toBe(row.id);
    }
  });

  it("works through createAdminDb's connection, which has no prepared statements (as behind a pooler)", async () => {
    // Regression: provisionTenant once passed a JSON helper and a Date that this kind of connection cannot serialise.
    const viaAdminDb = createAdminDb(inject("adminUrl"), { max: 1 });
    try {
      const shop = await provisionTenant(viaAdminDb.sql, {
        slug: `pooler-${suffix()}`, displayName: { en: "P", am: "ፒ" }, industry: "electronics", planKey: "pro",
        owner: { email: `pooler-${suffix()}@example.com`, displayName: "Pooler Owner" },
      });
      expect(shop.ownerInvite?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const [row] = await admin<{ display_name: { en: string; am: string }; invite_expires_at: Date }[]>`
        select t.display_name, s.invite_expires_at from platform.tenants t join app.staff s on s.tenant_id = t.id where t.id = ${shop.tenantId}`;
      expect(row?.display_name).toEqual({ en: "P", am: "ፒ" });
      expect(row?.invite_expires_at.getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000);
    } finally {
      await viaAdminDb.close();
    }
  });

  it("without an owner there is no staff and no invitation", async () => {
    const shop = await provisionTenant(admin, { slug: `noowner-${suffix()}`, displayName: { en: "N" }, industry: "other", planKey: "pro" });
    expect(shop.ownerInvite).toBeUndefined();
    const [row] = await admin<{ n: number }[]>`select count(*)::int as n from app.staff where tenant_id = ${shop.tenantId}`;
    expect(row?.n).toBe(0);
  });

  it("with an owner: an invited Owner whose token is stored only as a hash", async () => {
    const shop = await provisionTenant(admin, {
      slug: `inv-${suffix()}`, displayName: { en: "I" }, industry: "other", planKey: "pro",
      owner: { email: "  Owner@Example.COM ", displayName: " Abebe Kebede " },
    });
    const invite = shop.ownerInvite;
    expect(invite?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [staff] = await admin<{ id: string; status: string; display_name: string; role_id: string; invite_email: string; invite_token_hash: string; invite_expires_at: Date; auth_user_id: string | null }[]>`
      select id, status, display_name, role_id, invite_email, invite_token_hash, invite_expires_at, auth_user_id from app.staff where tenant_id = ${shop.tenantId}`;
    expect(staff).toMatchObject({ id: invite?.staffId, status: "invited", display_name: "Abebe Kebede", role_id: shop.roleIds.owner, invite_email: "owner@example.com", auth_user_id: null });
    expect(staff?.invite_token_hash).toBe(createHash("sha256").update(invite?.token ?? "").digest("hex"));
    const days = ((staff?.invite_expires_at.getTime() ?? 0) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
    // the token appears nowhere in the stored row
    const [dump] = await admin<{ t: string }[]>`select to_jsonb(s)::text as t from app.staff s where tenant_id = ${shop.tenantId}`;
    expect(dump?.t).not.toContain(invite?.token ?? "?");
  });

  it("never writes the email address, the token or its hash into the audit log", async () => {
    const shop = await shopWithOwnerInvite("redact", "private.person@example.com");
    const [hash] = await admin<{ h: string }[]>`select invite_token_hash as h from app.staff where tenant_id = ${shop.tenantId}`;
    const entries = await admin<{ before_data: unknown; after_data: Record<string, unknown> | null; table_name: string | null }[]>`
      select before_data, after_data, table_name from audit.log where tenant_id = ${shop.tenantId}`;
    const everything = JSON.stringify(entries);
    expect(everything).not.toContain("private.person@example.com");
    expect(everything).not.toContain(shop.token);
    expect(everything).not.toContain(hash?.h ?? "?");
    const staffInsert = entries.find((e) => e.table_name === "app.staff");
    expect(staffInsert?.after_data).toMatchObject({ invite_email: "[redacted]", invite_token_hash: "[redacted]", pin_hash: "[redacted]" });
  });

  it.each([["no-at-sign"], ["a@b"], ["with space@x.com"], [""], ["x".repeat(250) + "@example.com"]])("rejects the owner email %j", async (email) => {
    const slug = `badowner-${suffix()}`;
    const problem = await provisionTenant(admin, { slug, displayName: { en: "B" }, industry: "other", planKey: "pro", owner: { email, displayName: "O" } }).then(
      () => "none", (e: unknown) => (e instanceof TenantProvisioningError ? e.problem : String(e)));
    expect(problem).toBe("invalid_owner");
    const [row] = await admin<{ n: number }[]>`select count(*)::int as n from platform.tenants where slug = ${slug}`;
    expect(row?.n).toBe(0);
  });

  it("rejects a blank owner name", async () => {
    const problem = await provisionTenant(admin, { slug: `blankowner-${suffix()}`, displayName: { en: "B" }, industry: "other", planKey: "pro", owner: { email: "a@b.co", displayName: "  " } })
      .then(() => "none", (e: unknown) => (e instanceof TenantProvisioningError ? e.problem : String(e)));
    expect(problem).toBe("invalid_owner");
  });
});

// ── the new tables' own rules ───────────────────────────────────────────────
describe("roles, permissions, staff and sessions: the database's own rules", () => {
  async function tenantWithRole() {
    const tenant = await createTenant(admin, `rules-${suffix()}`);
    const roleId = newId();
    await admin`insert into app.roles (id, tenant_id, key, name) values (${roleId}, ${tenant}, ${randomLetters()}, ${admin.json({ en: "R" })})`;
    return { tenant, roleId };
  }
  const addStaff = (tenant: string, roleId: string, over: Record<string, unknown> = {}) => {
    const row = { id: newId(), status: "active", display_name: "Person", ...over };
    return Promise.resolve(
      admin`insert into app.staff ${admin({ tenant_id: tenant, role_id: roleId, ...row } as never)}`,
    ).then(() => row.id);
  };
  const addSession = (tenant: string, staffId: string, over: Record<string, unknown> = {}) =>
    Promise.resolve(
      admin`insert into app.staff_sessions ${admin({ id: newId(), tenant_id: tenant, staff_id: staffId, method: "password", expires_at: new Date(Date.now() + 3_600_000), ...over } as never)}`,
    );

  it.each(["Owner", "role1", "_x", "a-b", ""])("rejects the role key %j", async (key) => {
    const tenant = await createTenant(admin, `rk-${suffix()}`);
    await expectPgError(
      Promise.resolve(admin`insert into app.roles (id, tenant_id, key, name) values (${newId()}, ${tenant}, ${key}, ${admin.json({ en: "R" })})`),
      PG.checkViolation,
    );
  });

  it("allows one role per key per shop, but another shop may use the same key", async () => {
    const a = await createTenant(admin, `rd-a-${suffix()}`);
    const b = await createTenant(admin, `rd-b-${suffix()}`);
    const insert = (t: string) => Promise.resolve(admin`insert into app.roles (id, tenant_id, key, name) values (${newId()}, ${t}, 'cashier', ${admin.json({ en: "C" })})`);
    await insert(a);
    await expectPgError(insert(a), PG.uniqueViolation);
    await expect(insert(b)).resolves.toBeDefined();
  });

  it("requires a real name", async () => {
    const tenant = await createTenant(admin, `rn-${suffix()}`);
    await expectPgError(Promise.resolve(admin`insert into app.roles (id, tenant_id, key, name) values (${newId()}, ${tenant}, 'x', '{}'::jsonb)`), PG.checkViolation);
  });

  it("role permissions: well-formed keys, no duplicates, and only for a role of the same shop", async () => {
    const a = await tenantWithRole();
    const b = await tenantWithRole();
    const perm = (t: string, r: string, key: string) =>
      Promise.resolve(admin`insert into app.role_permissions (id, tenant_id, role_id, permission_key) values (${newId()}, ${t}, ${r}, ${key})`);
    await perm(a.tenant, a.roleId, "product:edit_price");
    await expectPgError(perm(a.tenant, a.roleId, "product:edit_price"), PG.uniqueViolation);
    for (const bad of ["product", "Product:view", "product:", ":view", "product:View", "a:b:c"]) {
      await expectPgError(perm(a.tenant, a.roleId, bad), PG.checkViolation);
    }
    await expectPgError(perm(a.tenant, b.roleId, "product:view"), PG.foreignKeyViolation); // another shop's role
  });

  it("staff: a name is required, and a role must belong to the same shop", async () => {
    const a = await tenantWithRole();
    const b = await tenantWithRole();
    await expectPgError(addStaff(a.tenant, a.roleId, { display_name: "   " }), PG.checkViolation);
    await expectPgError(addStaff(a.tenant, b.roleId), PG.foreignKeyViolation);
  });

  it("staff: an invited person must have a complete invitation and no account yet", async () => {
    const { tenant, roleId } = await tenantWithRole();
    await expectPgError(addStaff(tenant, roleId, { status: "invited" }), PG.checkViolation); // no token at all
    await expectPgError(addStaff(tenant, roleId, { status: "invited", invite_email: "a@b.co", invite_token_hash: "x".repeat(64) }), PG.checkViolation); // no expiry
    await expectPgError(
      addStaff(tenant, roleId, { status: "invited", invite_email: "a@b.co", invite_token_hash: "y".repeat(64), invite_expires_at: new Date(Date.now() + 1000), auth_user_id: newId() }),
      PG.checkViolation,
    );
    await expect(
      addStaff(tenant, roleId, { status: "invited", invite_email: "a@b.co", invite_token_hash: randomBytes(32).toString("hex"), invite_expires_at: new Date(Date.now() + 1000) }),
    ).resolves.toBeDefined();
  });

  it("staff: nobody but an invited person holds an invitation token, and emails are lowercase", async () => {
    const { tenant, roleId } = await tenantWithRole();
    await expectPgError(addStaff(tenant, roleId, { status: "active", invite_token_hash: "z".repeat(64) }), PG.checkViolation);
    await expectPgError(
      addStaff(tenant, roleId, { status: "invited", invite_email: "Mixed@Case.com", invite_token_hash: randomBytes(32).toString("hex"), invite_expires_at: new Date(Date.now() + 1000) }),
      PG.checkViolation,
    );
  });

  it("staff: one row per account per shop, but one account may work in several shops", async () => {
    const a = await tenantWithRole();
    const b = await tenantWithRole();
    const authUserId = newId();
    await addStaff(a.tenant, a.roleId, { auth_user_id: authUserId });
    await expectPgError(addStaff(a.tenant, a.roleId, { auth_user_id: authUserId }), PG.uniqueViolation);
    await expect(addStaff(b.tenant, b.roleId, { auth_user_id: authUserId })).resolves.toBeDefined();
  });

  it("staff: an invitation token hash is unique across ALL shops (it is looked up without knowing the shop)", async () => {
    const a = await tenantWithRole();
    const b = await tenantWithRole();
    const invite = { status: "invited", invite_email: "a@b.co", invite_token_hash: randomBytes(32).toString("hex"), invite_expires_at: new Date(Date.now() + 1000) };
    await addStaff(a.tenant, a.roleId, invite);
    await expectPgError(addStaff(b.tenant, b.roleId, invite), PG.uniqueViolation);
  });

  it("staff: PIN-only staff need no login account", async () => {
    const { tenant, roleId } = await tenantWithRole();
    await expect(addStaff(tenant, roleId, { auth_user_id: null, display_name: "Cashier Sara" })).resolves.toBeDefined();
  });

  it.each([
    ["a negative PIN failure count", { pin_failed_count: -1 }],
    ["an unknown calendar", { preferred_calendar: "julian" }],
    ["an unknown theme", { theme: "neon" }],
  ])("staff: rejects %s", async (_label, over) => {
    const { tenant, roleId } = await tenantWithRole();
    await expectPgError(addStaff(tenant, roleId, over), PG.checkViolation);
  });

  it("staff: accepts the supported calendars and themes", async () => {
    const { tenant, roleId } = await tenantWithRole();
    await expect(addStaff(tenant, roleId, { preferred_calendar: "ethiopian", theme: "dark", preferred_language: "am" })).resolves.toBeDefined();
  });

  it("sessions: only known methods and end reasons", async () => {
    const { tenant, roleId } = await tenantWithRole();
    const staffId = await addStaff(tenant, roleId);
    await expectPgError(addSession(tenant, staffId, { method: "carrier_pigeon" }), PG.checkViolation);
    await expectPgError(addSession(tenant, staffId, { ended_at: new Date(), ended_reason: "bored" }), PG.checkViolation);
  });

  it("sessions: either open (no end, no reason) or closed with a reason, never half of each", async () => {
    const { tenant, roleId } = await tenantWithRole();
    const staffId = await addStaff(tenant, roleId);
    await expectPgError(addSession(tenant, staffId, { ended_at: new Date() }), PG.checkViolation);
    await expectPgError(addSession(tenant, staffId, { ended_reason: "logout" }), PG.checkViolation);
    await expect(addSession(tenant, staffId, { ended_at: new Date(), ended_reason: "logout" })).resolves.toBeDefined();
  });

  it("sessions: must expire after they start, and belong to a staff member of the same shop", async () => {
    const a = await tenantWithRole();
    const b = await tenantWithRole();
    const staffA = await addStaff(a.tenant, a.roleId);
    await expectPgError(addSession(a.tenant, staffA, { expires_at: new Date(Date.now() - 1000) }), PG.checkViolation);
    await expectPgError(addSession(b.tenant, staffA), PG.foreignKeyViolation);
  });
});

// ── following an invitation ─────────────────────────────────────────────────
describe("accepting an invitation", () => {
  it("links the verified account, activates the person, and burns the token", async () => {
    const shop = await shopWithOwnerInvite("accept");
    const acct = account(shop.ownerEmail);
    const accepted = await db.identity(acct, (tx) => acceptInvite(tx, shop.token));
    expect(accepted).toEqual({ tenantId: shop.tenantId, staffId: shop.ownerInvite?.staffId });

    const [staff] = await admin<{ status: string; auth_user_id: string; invite_token_hash: string | null; invite_email: string | null; invite_expires_at: Date | null }[]>`
      select status, auth_user_id, invite_token_hash, invite_email, invite_expires_at from app.staff where id = ${accepted.staffId}`;
    expect(staff).toEqual({ status: "active", auth_user_id: acct.authUserId, invite_token_hash: null, invite_email: null, invite_expires_at: null });
  });

  it("records who did it in the audit log (the person who accepted), without any secret", async () => {
    const shop = await shopWithOwnerInvite("accept-audit");
    const acct = account(shop.ownerEmail);
    const accepted = await db.identity(acct, (tx) => acceptInvite(tx, shop.token));
    const entries = await admin<{ event_key: string; actor_kind: string; actor_id: string | null; table_name: string | null; before_data: Record<string, unknown> | null; after_data: Record<string, unknown> | null }[]>`
      select event_key, actor_kind, actor_id, table_name, before_data, after_data from audit.log where tenant_id = ${shop.tenantId} order by seq desc limit 2`;
    const event = entries.find((e) => e.event_key === "staff.invite_accepted");
    const rowChange = entries.find((e) => e.event_key === "row.update" && e.table_name === "app.staff");
    expect(event).toMatchObject({ actor_kind: "staff", actor_id: accepted.staffId });
    expect(rowChange).toMatchObject({ actor_kind: "staff", actor_id: accepted.staffId });
    expect(JSON.stringify(entries)).not.toContain(shop.token);
    expect(rowChange?.after_data).toMatchObject({ status: "active", invite_token_hash: "[redacted]" });
  });

  it("matches the email case-insensitively", async () => {
    const shop = await shopWithOwnerInvite("accept-case", "mixed.case@example.com");
    await expect(db.identity(account("MIXED.Case@Example.COM"), (tx) => acceptInvite(tx, shop.token))).resolves.toBeDefined();
  });

  const refused = async (shop: { token: string }, acct: ReturnType<typeof account>, token = shop.token) => {
    const failure = await db.identity(acct, (tx) => acceptInvite(tx, token)).then(() => undefined, (e: unknown) => e);
    expect(failure).toBeInstanceOf(InviteInvalidError);
  };
  const stillPending = async (shop: { ownerInvite?: { staffId: string } }) => {
    const [row] = await admin<{ status: string; auth_user_id: string | null }[]>`select status, auth_user_id from app.staff where id = ${shop.ownerInvite?.staffId ?? newId()}`;
    expect(row).toEqual({ status: "invited", auth_user_id: null });
  };

  it("refuses an account with a DIFFERENT email, and the invitation stays usable", async () => {
    const shop = await shopWithOwnerInvite("accept-wrong");
    await refused(shop, account("someone.else@example.com"));
    await stillPending(shop);
    await expect(db.identity(account(shop.ownerEmail), (tx) => acceptInvite(tx, shop.token))).resolves.toBeDefined();
  });

  it("refuses a token nobody was given, and junk that is not even shaped like a token", async () => {
    const shop = await shopWithOwnerInvite("accept-unknown");
    await refused(shop, account(shop.ownerEmail), generateInviteToken());
    for (const junk of ["", "short", "A".repeat(43) + "!", "x'; drop table app.staff; --", "A".repeat(500)]) {
      await refused(shop, account(shop.ownerEmail), junk);
    }
    await stillPending(shop);
  });

  it("refuses a token that was already used, even by the same account", async () => {
    const shop = await shopWithOwnerInvite("accept-reuse");
    const acct = account(shop.ownerEmail);
    await db.identity(acct, (tx) => acceptInvite(tx, shop.token));
    await refused(shop, acct);
    await refused(shop, account(shop.ownerEmail));
  });

  it("refuses an expired invitation", async () => {
    const shop = await shopWithOwnerInvite("accept-expired");
    await admin`update app.staff set invite_expires_at = now() - interval '1 minute' where id = ${shop.ownerInvite?.staffId ?? ""}`;
    await refused(shop, account(shop.ownerEmail));
  });

  it.each(["paused", "closed"])("refuses an invitation to a %s shop", async (status) => {
    const shop = await shopWithOwnerInvite(`accept-${status}`);
    await admin`update platform.tenants set status = ${status} where id = ${shop.tenantId}`;
    await refused(shop, account(shop.ownerEmail));
    await stillPending(shop);
  });

  it("gives ONE answer for every failure: it cannot be used to find out which tokens exist", async () => {
    const shop = await shopWithOwnerInvite("accept-oracle");
    const messages = new Set<string>();
    for (const [acct, token] of [
      [account(shop.ownerEmail), generateInviteToken()],
      [account("other@example.com"), shop.token],
      [account(shop.ownerEmail), "junk"],
    ] as const) {
      const failure = await db.identity(acct, (tx) => acceptInvite(tx, token)).then(() => undefined, (e: unknown) => e as Error);
      messages.add(`${failure?.name}: ${failure?.message}`);
    }
    expect(messages.size).toBe(1);
  });

  it("tells an account that is ALREADY a member apart, and leaves the second invitation pending", async () => {
    const first = await shopWithOwnerInvite("accept-member");
    const acct = account(first.ownerEmail);
    await db.identity(acct, (tx) => acceptInvite(tx, first.token));

    // a second invitation to the SAME shop for the same email
    const roleId = first.roleIds.manager;
    const second = generateInviteToken();
    await admin`insert into app.staff (id, tenant_id, display_name, role_id, status, invite_email, invite_token_hash, invite_expires_at)
                values (${newId()}, ${first.tenantId}, 'Again', ${roleId}, 'invited', ${first.ownerEmail}, ${await hashInviteToken(second)}, now() + interval '1 day')`;
    const failure = await db.identity(acct, (tx) => acceptInvite(tx, second)).then(() => undefined, (e: unknown) => e);
    expect(failure).toBeInstanceOf(AlreadyMemberError);
    const [row] = await admin<{ status: string }[]>`select status from app.staff where invite_token_hash = ${await hashInviteToken(second)}`;
    expect(row?.status).toBe("invited"); // rolled back: nothing half-done
  });

  it("needs a signed-in account: nothing works without an identity", async () => {
    const shop = await shopWithOwnerInvite("accept-anon");
    const failure = await db
      .rls({ tenantId: shop.tenantId }, (tx) => acceptInvite(tx, shop.token))
      .then(() => undefined, (e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(isSessionEndedError(failure) || (failure as { code?: string })?.code === "28000" || String((failure as Error)?.message)).toBeTruthy();
    await stillPending(shop);
  });

  it("two different accounts cannot both claim one token (it is a single use under a row lock)", async () => {
    const shop = await shopWithOwnerInvite("accept-race");
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => db.identity(account(shop.ownerEmail), (tx) => acceptInvite(tx, shop.token))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof InviteInvalidError)).toBe(true);
  });
});

// ── the shop picker ─────────────────────────────────────────────────────────
describe("the shop picker (listMyShops)", () => {
  it("lists every shop where the account is an active member, sorted by address", async () => {
    const a = await shopWithOwnerInvite("pick-b");
    const b = await shopWithOwnerInvite("pick-a");
    const email = `multi-${suffix()}@example.com`;
    // the same person is invited as owner of both shops
    await admin`update app.staff set invite_email = ${email} where id in (${a.ownerInvite?.staffId ?? ""}, ${b.ownerInvite?.staffId ?? ""})`;
    const acct = account(email);
    await db.identity(acct, (tx) => acceptInvite(tx, a.token));
    await db.identity(acct, (tx) => acceptInvite(tx, b.token));

    const shops = await db.identity(acct, (tx) => listMyShops(tx));
    expect(shops.map((s) => s.slug)).toEqual([a.slug, b.slug].sort());
    expect(shops[0]).toMatchObject({ roleKey: "owner", staffName: "Owner Person", tenantStatus: "pilot" });
    expect(shops.map((s) => s.tenantId).sort()).toEqual([a.tenantId, b.tenantId].sort());
  });

  it("is empty for an account that belongs to no shop, and never shows another account's shops", async () => {
    const { acct } = await ownerSignedIn("pick-private");
    expect(await db.identity(account(), (tx) => listMyShops(tx))).toEqual([]);
    expect((await db.identity(acct, (tx) => listMyShops(tx))).length).toBe(1);
  });

  it("leaves out shops where the person is suspended, archived or still only invited, and closed shops", async () => {
    const { acct, shop, accepted } = await ownerSignedIn("pick-hide");
    expect((await db.identity(acct, (tx) => listMyShops(tx))).length).toBe(1);
    await admin`update platform.tenants set status = 'closed' where id = ${shop.tenantId}`;
    expect(await db.identity(acct, (tx) => listMyShops(tx))).toEqual([]);
    await admin`update platform.tenants set status = 'active' where id = ${shop.tenantId}`;
    await admin`update app.staff set status = 'suspended' where id = ${accepted.staffId}`;
    expect(await db.identity(acct, (tx) => listMyShops(tx))).toEqual([]);
    await admin`update app.staff set status = 'active' where id = ${accepted.staffId}`;
    expect((await db.identity(acct, (tx) => listMyShops(tx))).length).toBe(1);
  });

  it("still offers a PAUSED shop (read-only is better than locked out)", async () => {
    const { acct, shop } = await ownerSignedIn("pick-paused");
    await admin`update platform.tenants set status = 'paused' where id = ${shop.tenantId}`;
    const shops = await db.identity(acct, (tx) => listMyShops(tx));
    expect(shops).toHaveLength(1);
    expect(shops[0]?.tenantStatus).toBe("paused");
  });

  it("refuses a malformed identity before touching the database", async () => {
    for (const bad of [{ authUserId: "x", email: "a@b.co" }, { authUserId: newId(), email: "nope" }, { authUserId: newId(), email: "" }, { authUserId: newId(), email: "a b@c.de" }]) {
      await expect(db.identity(bad, (tx) => listMyShops(tx))).rejects.toThrow(InvalidRlsContextError);
    }
  });

  it("shows no shop data through an identity-only session (tables are empty there)", async () => {
    const { acct } = await ownerSignedIn("pick-tables");
    const rows = await db.identity(acct, (tx) => tx.execute(sql`select (select count(*) from app.staff) as staff, (select count(*) from app.branches) as branches`));
    expect(rows[0]).toEqual({ staff: "0", branches: "0" });
  });
});

// ── starting and ending sessions ────────────────────────────────────────────
describe("starting a session", () => {
  it("opens a session for the verified account in the chosen shop", async () => {
    const { session, shop, accepted } = await ownerSignedIn("start");
    expect(session).toMatchObject({ tenantId: shop.tenantId, staffId: accepted.staffId });
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6.9 * 86_400_000);
    const [row] = await admin<{ staff_id: string; method: string; ended_at: Date | null }[]>`select staff_id, method, ended_at from app.staff_sessions where id = ${session.sessionId}`;
    expect(row).toMatchObject({ staff_id: accepted.staffId, method: "password", ended_at: null });
  });

  it("records who started it in the audit log", async () => {
    const { session, shop } = await ownerSignedIn("start-audit");
    const [entry] = await admin<{ actor_kind: string; actor_id: string | null; table_name: string }[]>`
      select actor_kind, actor_id, table_name from audit.log where tenant_id = ${shop.tenantId} and row_id = ${session.sessionId}`;
    expect(entry).toMatchObject({ actor_kind: "staff", actor_id: session.staffId, table_name: "app.staff_sessions" });
  });

  it("honours a shorter lifetime (a till session)", async () => {
    const { acct, shop } = await ownerSignedIn("start-short");
    const s = await db.identity(acct, (tx) => startSession(tx, { tenantId: shop.tenantId, method: "google", hours: 12 }));
    expect(s.expiresAt.getTime()).toBeLessThan(Date.now() + 12.1 * 3_600_000);
    expect(s.expiresAt.getTime()).toBeGreaterThan(Date.now() + 11.9 * 3_600_000);
  });

  it("refuses an account that is not a member of that shop", async () => {
    const mine = await ownerSignedIn("start-mine");
    const other = await shopWithOwnerInvite("start-other");
    const failure = await db.identity(mine.acct, (tx) => startSession(tx, { tenantId: other.tenantId, method: "password" })).then(() => undefined, (e: unknown) => e);
    expect(failure).toBeInstanceOf(NoShopAccessError);
  });

  it("refuses a suspended person, and a closed shop; allows a paused one", async () => {
    const { acct, shop, accepted } = await ownerSignedIn("start-states");
    const attempt = () => db.identity(acct, (tx) => startSession(tx, { tenantId: shop.tenantId, method: "password" }));
    await admin`update platform.tenants set status = 'paused' where id = ${shop.tenantId}`;
    await expect(attempt()).resolves.toBeDefined();
    await admin`update platform.tenants set status = 'closed' where id = ${shop.tenantId}`;
    await expect(attempt()).rejects.toThrow(NoShopAccessError);
    await admin`update platform.tenants set status = 'active' where id = ${shop.tenantId}`;
    await admin`update app.staff set status = 'suspended' where id = ${accepted.staffId}`;
    await expect(attempt()).rejects.toThrow(NoShopAccessError);
  });

  it("only accounts methods; PIN and Telegram sign-ins are different paths", async () => {
    const { acct, shop } = await ownerSignedIn("start-method");
    for (const method of ["pin", "telegram", "carrier_pigeon"]) {
      await expectPgError(
        db.identity(acct, (tx) => tx.execute(sql`select * from app.start_session(${newId()}::uuid, ${shop.tenantId}::uuid, ${method}, now() + interval '1 hour')`)),
        PG.checkViolation,
      );
    }
  });

  it("refuses an expiry in the past or more than 31 days ahead", async () => {
    const { acct, shop } = await ownerSignedIn("start-expiry");
    for (const expiry of ["now() - interval '1 minute'", "now() + interval '32 days'"]) {
      await expectPgError(
        db.identity(acct, (tx) => tx.execute(sql.raw(`select * from app.start_session('${newId()}'::uuid, '${shop.tenantId}'::uuid, 'password', ${expiry})`))),
        PG.checkViolation,
      );
    }
  });

  it("needs a signed-in account", async () => {
    const shop = await shopWithOwnerInvite("start-anon");
    await expect(
      db.rls({ tenantId: shop.tenantId }, (tx) => tx.execute(sql`select * from app.start_session(${newId()}::uuid, ${shop.tenantId}::uuid, 'password', now() + interval '1 hour')`)),
    ).rejects.toBeDefined();
  });
});

describe("a request inside a shop", () => {
  it("works with a live session, and the person can read the shop's own details", async () => {
    const { ctx } = await ownerSignedIn("req-ok");
    const rows = await read(ctx);
    expect(Number((rows[0] as { n: number }).n)).toBeGreaterThan(0);
  });

  it("is recorded as that staff member in the audit log", async () => {
    const { ctx, shop } = await ownerSignedIn("req-actor");
    await write(ctx);
    const [entry] = await admin<{ actor_kind: string; actor_id: string | null; session_id: string | null }[]>`
      select actor_kind, actor_id, session_id from audit.log where tenant_id = ${shop.tenantId} and event_key = 'row.update' and table_name = 'app.branches' order by seq desc limit 1`;
    expect(entry).toMatchObject({ actor_kind: "staff", actor_id: ctx.staffId, session_id: ctx.sessionId });
  });
});

// ── the done-when: suspending someone ends their session on the very next request ──
describe("ending a session", () => {
  it("SUSPENDING a staff member ends their session on the very next request (done-when for A7)", async () => {
    const { ctx, accepted, session } = await ownerSignedIn("end-suspend");
    await expect(read(ctx)).resolves.toBeDefined(); // works now
    await admin`update app.staff set status = 'suspended' where id = ${accepted.staffId}`;

    await expect(read(ctx)).rejects.toThrow(SessionEndedError); // refused immediately
    await expect(write(ctx)).rejects.toThrow(SessionEndedError);

    const [row] = await admin<{ ended_reason: string | null; ended_at: Date | null }[]>`select ended_reason, ended_at from app.staff_sessions where id = ${session.sessionId}`;
    expect(row?.ended_reason).toBe("staff_suspended");
    expect(row?.ended_at).toBeInstanceOf(Date);
  });

  it("archiving ends it too, and so does a suspension done by the shop's own owner through the app", async () => {
    const { shop, ctx } = await ownerSignedIn("end-archive");
    // a second person, a cashier with an account, signed in
    const cashierAcct = account(`cashier-${suffix()}@example.com`);
    const staffId = newId();
    const invite = generateInviteToken();
    await admin`insert into app.staff (id, tenant_id, display_name, role_id, status, invite_email, invite_token_hash, invite_expires_at)
                values (${staffId}, ${shop.tenantId}, 'Cashier', ${shop.roleIds.cashier}, 'invited', ${cashierAcct.email}, ${await hashInviteToken(invite)}, now() + interval '1 day')`;
    await db.identity(cashierAcct, (tx) => acceptInvite(tx, invite));
    const cashier = await db.identity(cashierAcct, (tx) => startSession(tx, { tenantId: shop.tenantId, method: "password" }));
    const cashierCtx: RlsContext = { tenantId: shop.tenantId, staffId: cashier.staffId, sessionId: cashier.sessionId };
    await expect(read(cashierCtx)).resolves.toBeDefined();

    // the OWNER, through the normal app path, suspends the cashier
    await db.rls(ctx, (tx) => tx.execute(sql`update app.staff set status = 'suspended' where id = ${staffId}`), { write: true });
    await expect(read(cashierCtx)).rejects.toThrow(SessionEndedError);
    await expect(read(ctx)).resolves.toBeDefined(); // the owner is unaffected

    await admin`update app.staff set status = 'active' where id = ${staffId}`;
    const another = await db.identity(cashierAcct, (tx) => startSession(tx, { tenantId: shop.tenantId, method: "password" }));
    const anotherCtx: RlsContext = { tenantId: shop.tenantId, staffId: another.staffId, sessionId: another.sessionId };
    await expect(read(anotherCtx)).resolves.toBeDefined();
    await admin`update app.staff set status = 'archived' where id = ${staffId}`;
    await expect(read(anotherCtx)).rejects.toThrow(SessionEndedError);
    const [row] = await admin<{ ended_reason: string }[]>`select ended_reason from app.staff_sessions where id = ${another.sessionId}`;
    expect(row?.ended_reason).toBe("staff_suspended"); // archiving records the same reason in the stored state
  });

  it("reinstating someone does NOT revive the sessions that were ended; they sign in again", async () => {
    const { ctx, accepted, acct, shop } = await ownerSignedIn("end-reinstate");
    await admin`update app.staff set status = 'suspended' where id = ${accepted.staffId}`;
    await admin`update app.staff set status = 'active' where id = ${accepted.staffId}`;
    await expect(read(ctx)).rejects.toThrow(SessionEndedError);
    const fresh = await db.identity(acct, (tx) => startSession(tx, { tenantId: shop.tenantId, method: "password" }));
    await expect(read({ tenantId: shop.tenantId, staffId: fresh.staffId, sessionId: fresh.sessionId })).resolves.toBeDefined();
  });

  it("suspending one person does not end anyone else's session", async () => {
    const a = await ownerSignedIn("end-iso-a");
    const b = await ownerSignedIn("end-iso-b");
    await admin`update app.staff set status = 'suspended' where id = ${a.accepted.staffId}`;
    await expect(read(a.ctx)).rejects.toThrow(SessionEndedError);
    await expect(read(b.ctx)).resolves.toBeDefined();
  });

  it("the check itself fails closed when no session is claimed (it never silently passes)", async () => {
    const shop = await shopWithOwnerInvite("end-strict");
    await expectPgError(
      db.rls({ tenantId: shop.tenantId }, (tx) => tx.execute(sql`select private.assert_session_active()`)),
      "28000",
    );
  });

  it("defence in depth: a suspended person is refused even if the trigger that ends sessions is switched off", async () => {
    const { ctx, accepted, session } = await ownerSignedIn("end-depth");
    await admin.unsafe("alter table app.staff disable trigger end_sessions_on_inactive");
    try {
      await admin`update app.staff set status = 'suspended' where id = ${accepted.staffId}`;
      const [row] = await admin<{ ended_at: Date | null }[]>`select ended_at from app.staff_sessions where id = ${session.sessionId}`;
      expect(row?.ended_at, "the trigger is off, so the stored session is still open").toBeNull();
      await expect(read(ctx)).rejects.toThrow(SessionEndedError); // the per-request check alone stops them
    } finally {
      await admin.unsafe("alter table app.staff enable trigger end_sessions_on_inactive");
    }
  });

  it("a session row opened for a person who is already suspended is refused", async () => {
    const { shop, accepted } = await ownerSignedIn("end-late");
    await admin`update app.staff set status = 'suspended' where id = ${accepted.staffId}`;
    const lateSession = newId();
    await admin`insert into app.staff_sessions (id, tenant_id, staff_id, method, expires_at)
                values (${lateSession}, ${shop.tenantId}, ${accepted.staffId}, 'password', now() + interval '1 day')`;
    await expect(read({ tenantId: shop.tenantId, staffId: accepted.staffId, sessionId: lateSession })).rejects.toThrow(SessionEndedError);
  });

  it("an EXPIRED session is refused", async () => {
    const { ctx, session } = await ownerSignedIn("end-expired");
    await admin.unsafe(`alter table app.staff_sessions disable trigger touch_updated_at`);
    try {
      await admin`update app.staff_sessions set started_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where id = ${session.sessionId}`;
    } finally {
      await admin.unsafe(`alter table app.staff_sessions enable trigger touch_updated_at`);
    }
    await expect(read(ctx)).rejects.toThrow(SessionEndedError);
  });

  it("signing out ends THIS session only", async () => {
    const { ctx, acct, shop } = await ownerSignedIn("end-logout");
    const other = await db.identity(acct, (tx) => startSession(tx, { tenantId: shop.tenantId, method: "password" }));
    const otherCtx: RlsContext = { tenantId: shop.tenantId, staffId: other.staffId, sessionId: other.sessionId };

    expect(await db.rls(ctx, (tx) => endMySession(tx))).toBe(true);
    await expect(read(ctx)).rejects.toThrow(SessionEndedError);
    await expect(read(otherCtx)).resolves.toBeDefined();
    const [row] = await admin<{ ended_reason: string }[]>`select ended_reason from app.staff_sessions where id = ${ctx.sessionId ?? ""}`;
    expect(row?.ended_reason).toBe("logout");
  });

  it("signing out leaves the rest of that request still inside its shop", async () => {
    const { ctx } = await ownerSignedIn("end-stay");
    const afterwards = await db.rls(ctx, async (tx) => {
      await endMySession(tx);
      return tx.execute<{ n: number; tenant: string | null }>(
        sql`select (select count(*)::int from app.branches) as n, current_setting('app.tenant_id', true) as tenant`,
      );
    });
    expect(Number((afterwards[0] as { n: number }).n)).toBeGreaterThan(0);
    expect((afterwards[0] as { tenant: string }).tenant).toBe(ctx.tenantId);
  });

  it("signing out twice is harmless", async () => {
    const { ctx } = await ownerSignedIn("end-twice");
    expect(await db.rls(ctx, (tx) => endMySession(tx))).toBe(true);
    await expect(db.rls(ctx, (tx) => endMySession(tx))).rejects.toThrow(SessionEndedError); // the session is over, so the request is refused first
  });

  it("a closed shop's sessions are refused", async () => {
    const { ctx, shop } = await ownerSignedIn("end-closed");
    await admin`update platform.tenants set status = 'closed' where id = ${shop.tenantId}`;
    await expect(read(ctx)).rejects.toThrow(SessionEndedError);
  });

  it("a PAUSED shop's session can still read and can sign out, but cannot change anything", async () => {
    const { ctx, shop } = await ownerSignedIn("end-paused");
    await admin`update platform.tenants set status = 'paused' where id = ${shop.tenantId}`;
    await expect(read(ctx)).resolves.toBeDefined();
    const failure = await write(ctx).then(() => undefined, (e: unknown) => e);
    expect(isShopReadOnlyError(failure)).toBe(true);
    expect(await db.rls(ctx, (tx) => endMySession(tx))).toBe(true); // sign-out is not a write the lock refuses
  });

  it("a session cannot be used for a different shop or a different person", async () => {
    const a = await ownerSignedIn("end-cross-a");
    const b = await ownerSignedIn("end-cross-b");
    await expect(read({ tenantId: b.shop.tenantId, staffId: a.session.staffId, sessionId: a.session.sessionId })).rejects.toThrow(SessionEndedError);
    await expect(read({ tenantId: a.shop.tenantId, staffId: b.session.staffId, sessionId: a.session.sessionId })).rejects.toThrow(SessionEndedError);
    await expect(read({ tenantId: a.shop.tenantId, staffId: a.session.staffId, sessionId: b.session.sessionId })).rejects.toThrow(SessionEndedError);
  });

  it("a made-up session or staff id is refused", async () => {
    const { ctx } = await ownerSignedIn("end-fake");
    await expect(read({ ...ctx, sessionId: newId() })).rejects.toThrow(SessionEndedError);
    await expect(read({ ...ctx, staffId: newId() })).rejects.toThrow(SessionEndedError);
  });

  it("claiming a staff member without a session is not accepted at all", async () => {
    const { ctx } = await ownerSignedIn("end-nosession");
    await expect(read({ tenantId: ctx.tenantId, staffId: ctx.staffId })).rejects.toThrow(InvalidRlsContextError);
  });

  it("platform code that claims no session is not checked (support, billing, scripts)", async () => {
    const shop = await shopWithOwnerInvite("end-platform");
    await expect(read({ tenantId: shop.tenantId })).resolves.toBeDefined();
  });

  it("sign-out needs a session", async () => {
    const shop = await shopWithOwnerInvite("end-nosess-out");
    await expect(db.rls({ tenantId: shop.tenantId }, (tx) => endMySession(tx))).rejects.toThrow(SessionEndedError);
  });
});

// ── the command ─────────────────────────────────────────────────────────────
describe("pnpm tenant:create --owner-email", () => {
  function run(args: string[]) {
    return spawnSync("pnpm", ["exec", "tsx", "src/bin/create-tenant.ts", ...args], {
      shell: true,
      encoding: "utf8",
      env: { ...process.env, DATABASE_ADMIN_URL: inject("adminUrl") },
    });
  }

  it("prints the invitation once, and that token really lets the owner in", async () => {
    const slug = `cliowner-${suffix()}`;
    const email = `cli-${suffix()}@example.com`;
    const result = run(["--slug", slug, "--name", "Shop", "--industry", "other", "--plan", "pro", "--owner-email", email, "--owner-name", "Owner"]);
    expect(result.status, result.stderr).toBe(0);
    const token = /path:\s+\/invite\/([A-Za-z0-9_-]{43})/.exec(result.stdout)?.[1];
    expect(token).toBeTruthy();
    expect(result.stdout).toContain("shown only now");

    const accepted = await db.identity(account(email), (tx) => acceptInvite(tx, token ?? ""));
    const [row] = await admin<{ slug: string }[]>`select slug from platform.tenants where id = ${accepted.tenantId}`;
    expect(row?.slug).toBe(slug);
  }, 60_000);

  it("needs the owner's email and name together", () => {
    for (const extra of [["--owner-email", "a@b.co"], ["--owner-name", "Owner"]]) {
      const result = run(["--slug", `cli-partial-${suffix()}`, "--name", "S", "--industry", "other", "--plan", "pro", ...extra]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("must be given together");
    }
  }, 60_000);

  it("refuses an invalid owner email without creating the shop", async () => {
    const slug = `cli-bademail-${suffix()}`;
    const result = run(["--slug", slug, "--name", "S", "--industry", "other", "--plan", "pro", "--owner-email", "nope", "--owner-name", "O"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not a valid email");
    const [row] = await admin<{ n: number }[]>`select count(*)::int as n from platform.tenants where slug = ${slug}`;
    expect(row?.n).toBe(0);
  }, 60_000);
});
