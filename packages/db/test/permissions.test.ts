import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS, PERMISSION_KEYS, ROLE_TEMPLATE_PERMISSIONS, defaultModulesFor, hmacHex, permissionsOfModules, resolvePermissions, type OverrideEffect, type PermissionKey } from "@retail/core";
import { createPairingCode } from "../src/devices";
import {
  PermissionDeniedError,
  createStaff,
  getMyPermissions,
  getPermissionsOf,
  removeOverride,
  requirePermission,
  setOverride,
  setRolePermission,
  setStaffRole,
} from "../src/permissions";
import { createTenantDb, type RlsContext, type TenantDb } from "../src/rls";
import { acceptInvite, startSession } from "../src/sign-in";
import { provisionTenant } from "../src/tenants";
import { PG, adminSql, appUrl, expectPgError, newId, pgCode } from "./helpers";

const admin: Sql = adminSql(6);
let db: TenantDb;

beforeAll(() => {
  db = createTenantDb(appUrl(), { max: 12 });
});
afterAll(async () => {
  await db.close();
  await admin.end();
});

const suffix = () => randomBytes(4).toString("hex");
const letters = (n = 8) => Array.from(randomBytes(n), (b) => String.fromCharCode(97 + (b % 26))).join("");

interface Shop {
  tenantId: string;
  branchId: string;
  roleIds: Record<string, string>;
  ownerId: string;
  owner: RlsContext;
}

/** A shop whose owner followed the invitation and is signed in. */
async function makeShop(prefix: string): Promise<Shop> {
  const email = `owner-${suffix()}@example.com`;
  const shop = await provisionTenant(admin, {
    slug: `${prefix}-${suffix()}`,
    displayName: { en: `Shop ${prefix}` },
    industry: "electronics",
    planKey: "pro",
    owner: { email, displayName: "Owner Person" },
  });
  const acct = { authUserId: newId(), email };
  await db.identity(acct, (tx) => acceptInvite(tx, shop.ownerInvite?.token ?? ""));
  const session = await db.identity(acct, (tx) => startSession(tx, { tenantId: shop.tenantId, method: "password" }));
  return {
    tenantId: shop.tenantId,
    branchId: shop.branchId,
    roleIds: shop.roleIds,
    ownerId: session.staffId,
    owner: { tenantId: shop.tenantId, staffId: session.staffId, sessionId: session.sessionId },
  };
}

/** Someone with a system role and a live session (made with the owner login, as the console would). */
async function person(shop: Shop, roleKey: "owner" | "manager" | "cashier" | "stock_clerk" | "viewer") {
  const staffId = newId();
  const sessionId = newId();
  await admin`insert into app.staff (id, tenant_id, display_name, role_id, status) values (${staffId}, ${shop.tenantId}, ${`${roleKey} ${suffix()}`}, ${shop.roleIds[roleKey] as string}, 'active')`;
  await admin`insert into app.staff_sessions (id, tenant_id, staff_id, method, expires_at) values (${sessionId}, ${shop.tenantId}, ${staffId}, 'password', now() + interval '1 day')`;
  const ctx: RlsContext = { tenantId: shop.tenantId, staffId, sessionId };
  return { staffId, ctx };
}

/** A custom role holding exactly these keys. */
async function customRole(shop: Shop, keys: string[]) {
  const roleId = newId();
  await admin`insert into app.roles (id, tenant_id, key, name) values (${roleId}, ${shop.tenantId}, ${letters()}, '{"en": "Custom"}'::jsonb)`;
  for (const key of keys) await admin`insert into app.role_permissions (id, tenant_id, role_id, permission_key) values (${newId()}, ${shop.tenantId}, ${roleId}, ${key})`;
  return roleId;
}

async function personWithRole(shop: Shop, roleId: string) {
  const staffId = newId();
  const sessionId = newId();
  await admin`insert into app.staff (id, tenant_id, display_name, role_id, status) values (${staffId}, ${shop.tenantId}, 'Custom person', ${roleId}, 'active')`;
  await admin`insert into app.staff_sessions (id, tenant_id, staff_id, method, expires_at) values (${sessionId}, ${shop.tenantId}, ${staffId}, 'password', now() + interval '1 day')`;
  return { staffId, ctx: { tenantId: shop.tenantId, staffId, sessionId } as RlsContext };
}

const perms = (ctx: RlsContext, staffId: string) => db.rls(ctx, (tx) => getPermissionsOf(tx, staffId));
const write = <T>(ctx: RlsContext, fn: Parameters<TenantDb["rls"]>[1]) => db.rls(ctx, fn as never, { write: true }) as Promise<T>;

describe("the system roles' permissions", () => {
  it("a new shop's roles hold exactly their templates, and the owner holds everything", async () => {
    const shop = await makeShop("tpl");
    const rows = await admin`select r.key, rp.permission_key from app.role_permissions rp join app.roles r on r.id = rp.role_id and r.tenant_id = rp.tenant_id where rp.tenant_id = ${shop.tenantId}`;
    for (const role of ["manager", "cashier", "stock_clerk", "viewer"] as const) {
      expect(rows.filter((r) => r.key === role).map((r) => r.permission_key).sort(), role).toEqual([...ROLE_TEMPLATE_PERMISSIONS[role]].sort());
    }
    expect(rows.some((r) => r.key === "owner")).toBe(false);
    expect((await perms(shop.owner, shop.ownerId)).size).toBe(permissionsOfModules(defaultModulesFor("electronics")).length);
    expect(PERMISSIONS.length).toBeGreaterThan(permissionsOfModules(defaultModulesFor("electronics")).length); // dube, storefront ... are not on by default
  });

  it("what a person may do follows their role, and a switched-off module takes its keys away from everyone, the owner too", async () => {
    const shop = await makeShop("mods");
    const cashier = await person(shop, "cashier");
    const manager = await person(shop, "manager");
    expect(await perms(shop.owner, cashier.staffId)).toEqual(new Set(resolvePermissions({ roleKey: "cashier", rolePermissions: ROLE_TEMPLATE_PERMISSIONS.cashier, overrides: [], enabledModules: ["pos", "inventory", "payments", "promotions", "reports", "announcements", "serials"] })));
    const before = await perms(shop.owner, manager.staffId);
    expect(before.has("stock:adjust")).toBe(true);
    await admin`update platform.tenant_modules set enabled = false where tenant_id = ${shop.tenantId} and module_key = 'inventory'`;
    const after = await perms(shop.owner, manager.staffId);
    expect(after.has("stock:adjust")).toBe(false);
    expect(after.has("sale:create")).toBe(true);
    expect((await perms(shop.owner, shop.ownerId)).has("stock:view")).toBe(false);
    expect((await perms(shop.owner, shop.ownerId)).has("staff:manage")).toBe(true);
  });

  it("someone who is not active, or unknown, holds nothing", async () => {
    const shop = await makeShop("inactive");
    const manager = await person(shop, "manager");
    await admin`update app.staff set status = 'suspended' where id = ${manager.staffId}`;
    expect((await perms(shop.owner, manager.staffId)).size).toBe(0);
    expect((await perms(shop.owner, newId())).size).toBe(0);
    const [row] = await admin`select private.has_permission(${shop.tenantId}::uuid, ${manager.staffId}::uuid, 'sale:create') as ok`;
    expect(row?.ok).toBe(false);
  });

  it("requirePermission reads the database afresh each time: a deny takes effect on the very next call", async () => {
    const shop = await makeShop("fresh");
    const manager = await person(shop, "manager");
    await db.rls(manager.ctx, (tx) => requirePermission(tx, "sale:void"));
    expect((await db.rls(manager.ctx, (tx) => getMyPermissions(tx))).has("sale:void")).toBe(true);
    await write(shop.owner, (tx) => setOverride(tx, { staffId: manager.staffId, key: "sale:void", effect: "deny", reason: "trust lost" }));
    await expect(db.rls(manager.ctx, (tx) => requirePermission(tx, "sale:void"))).rejects.toBeInstanceOf(PermissionDeniedError);
    await write(shop.owner, (tx) => removeOverride(tx, { staffId: manager.staffId, key: "sale:void" }));
    await db.rls(manager.ctx, (tx) => requirePermission(tx, "sale:void"));
  });
});

describe("the database and core agree on who holds what", () => {
  it("for 40 random people (roles, allows, denies, owners), has_permission equals the resolver for every key", async () => {
    const shop = await makeShop("parity");
    const rnd = () => randomBytes(1)[0] ?? 0;
    for (let i = 0; i < 40; i++) {
      const isOwner = rnd() % 5 === 0;
      const roleKeys = PERMISSION_KEYS.filter(() => rnd() % 3 === 0);
      const roleId = isOwner ? shop.roleIds.owner : await customRole(shop, roleKeys);
      const { staffId } = await personWithRole(shop, roleId as string);
      const overrides = PERMISSION_KEYS.filter(() => rnd() % 9 === 0).map((key) => ({ key, effect: (rnd() % 2 === 0 ? "allow" : "deny") as OverrideEffect }));
      for (const o of overrides) {
        await admin`insert into app.staff_permission_overrides (id, tenant_id, staff_id, permission_key, effect, reason, granted_by) values (${newId()}, ${shop.tenantId}, ${staffId}, ${o.key}, ${o.effect}, 'parity', ${shop.ownerId})`;
      }
      const expected = resolvePermissions({ roleKey: isOwner ? "owner" : "custom", rolePermissions: isOwner ? [] : roleKeys, overrides, enabledModules: ["pos", "inventory", "payments", "dube", "promotions", "reports", "serials", "announcements", "storefront", "manufacturing", "transfers"] });
      const rows = await admin<{ key: string; ok: boolean }[]>`
        select k as key, private.has_permission(${shop.tenantId}::uuid, ${staffId}::uuid, k) as ok
        from jsonb_array_elements_text(${JSON.stringify(PERMISSION_KEYS)}::text::jsonb) as k`;
      const actual = new Set(rows.filter((r) => r.ok).map((r) => r.key));
      expect(actual, `person ${i}`).toEqual(expected as Set<string>);
    }
  });

  it("malformed keys are never held, even by the owner", async () => {
    const shop = await makeShop("malformed");
    for (const key of ["", "nocolon", "UPPER:case", "a:b:c", "a: b", "ok_key:", ":action", "sale:Create"]) {
      const [row] = await admin`select private.has_permission(${shop.tenantId}::uuid, ${shop.ownerId}::uuid, ${key}) as ok`;
      expect(row?.ok, key).toBe(false);
    }
    const [none] = await admin`select private.has_permission(${shop.tenantId}::uuid, ${shop.ownerId}::uuid, null) as ok`;
    expect(none?.ok).toBe(false);
  });
});

describe("nothing writes the permission tables directly", () => {
  it("the shop's own login is refused on roles, role permissions, overrides, new staff and role changes", async () => {
    const shop = await makeShop("direct");
    const cashier = await person(shop, "cashier");
    const refuse = (statement: ReturnType<typeof sql>) => expectPgError(db.rls(shop.owner, (tx) => tx.execute(statement), { write: true }), PG.permissionDenied);

    await refuse(sql`insert into app.role_permissions (id, tenant_id, role_id, permission_key) values (${newId()}, ${shop.tenantId}, ${shop.roleIds.cashier as string}, 'staff:manage')`);
    await refuse(sql`update app.role_permissions set permission_key = 'staff:manage' where tenant_id = ${shop.tenantId} and role_id = ${shop.roleIds.cashier as string}`);
    await refuse(sql`delete from app.role_permissions where tenant_id = ${shop.tenantId} and role_id = ${shop.roleIds.cashier as string}`);
    await refuse(sql`insert into app.staff_permission_overrides (id, tenant_id, staff_id, permission_key, effect, reason, granted_by) values (${newId()}, ${shop.tenantId}, ${cashier.staffId}, 'staff:manage', 'allow', 'x', ${shop.ownerId})`);
    await refuse(sql`insert into app.roles (id, tenant_id, key, name) values (${newId()}, ${shop.tenantId}, 'sneaky', '{"en": "x"}'::jsonb)`);
    await refuse(sql`update app.roles set name = '{"en": "Renamed"}'::jsonb where tenant_id = ${shop.tenantId} and key = 'cashier'`);
    await refuse(sql`insert into app.staff (id, tenant_id, display_name, role_id, status) values (${newId()}, ${shop.tenantId}, 'Sneaky owner', ${shop.roleIds.owner as string}, 'active')`);
    await refuse(sql`update app.staff set role_id = ${shop.roleIds.owner as string} where id = ${cashier.staffId}`);
    expect((await perms(shop.owner, cashier.staffId)).has("staff:manage")).toBe(false);
  });

  it("ordinary staff edits (name, status, PIN fields) still work for the shop's login", async () => {
    const shop = await makeShop("ordinary");
    const cashier = await person(shop, "cashier");
    await write(shop.owner, (tx) => tx.execute(sql`update app.staff set display_name = 'Renamed', phone = '0911' where id = ${cashier.staffId}`));
    const [row] = await admin`select display_name from app.staff where id = ${cashier.staffId}`;
    expect(row?.display_name).toBe("Renamed");
  });
});

describe("adding people and changing roles", () => {
  it("a manager can add a cashier (and a peer manager), but not an owner, or a role holding keys they lack", async () => {
    const shop = await makeShop("create");
    const manager = await person(shop, "manager");
    const make = (roleId: string) => write<string>(manager.ctx, (tx) => createStaff(tx, { id: newId(), displayName: "New person", roleId }));
    const cashierId = await make(shop.roleIds.cashier as string);
    const [row] = await admin`select status, role_id, auth_user_id, created_by from app.staff where id = ${cashierId}`;
    expect(row).toMatchObject({ status: "active", role_id: shop.roleIds.cashier, auth_user_id: null, created_by: manager.staffId });
    await make(shop.roleIds.manager as string);
    await expectPgError(make(shop.roleIds.owner as string), PG.permissionDenied);
    const wide = await customRole(shop, ["sale:create", "role:manage"]);
    await expectPgError(make(wide), PG.permissionDenied);
    await expectPgError(make(newId()), PG.checkViolation);
  });

  it("only an owner can add an owner; a cashier cannot add anyone", async () => {
    const shop = await makeShop("create2");
    const cashier = await person(shop, "cashier");
    await write(shop.owner, (tx) => createStaff(tx, { id: newId(), displayName: "Second owner", roleId: shop.roleIds.owner as string }));
    await expectPgError(write(cashier.ctx, (tx) => createStaff(tx, { id: newId(), displayName: "Nope", roleId: shop.roleIds.viewer as string })), PG.permissionDenied);
  });

  it("branch limits are stored", async () => {
    const shop = await makeShop("create3");
    const id = await write<string>(shop.owner, (tx) => createStaff(tx, { id: newId(), displayName: "At one branch", roleId: shop.roleIds.cashier as string, branchIds: [shop.branchId], phone: "0911000000" }));
    const [row] = await admin`select branch_ids, phone from app.staff where id = ${id}`;
    expect(row?.branch_ids).toEqual([shop.branchId]);
    expect(row?.phone).toBe("0911000000");
  });

  it("you cannot change your own role, even to a lesser one", async () => {
    const shop = await makeShop("ownrole");
    const manager = await person(shop, "manager");
    await expectPgError(write(manager.ctx, (tx) => setStaffRole(tx, manager.staffId, shop.roleIds.cashier as string)), PG.permissionDenied);
    await expectPgError(write(shop.owner, (tx) => setStaffRole(tx, shop.ownerId, shop.roleIds.cashier as string)), PG.permissionDenied);
  });

  it("a manager can promote a cashier to manager, but not to owner, and cannot touch an owner at all", async () => {
    const shop = await makeShop("promote");
    const manager = await person(shop, "manager");
    const cashier = await person(shop, "cashier");
    const otherOwner = await person(shop, "owner");
    await write(manager.ctx, (tx) => setStaffRole(tx, cashier.staffId, shop.roleIds.manager as string));
    expect((await perms(shop.owner, cashier.staffId)).has("staff:manage")).toBe(true);
    await expectPgError(write(manager.ctx, (tx) => setStaffRole(tx, cashier.staffId, shop.roleIds.owner as string)), PG.permissionDenied);
    await expectPgError(write(manager.ctx, (tx) => setStaffRole(tx, otherOwner.staffId, shop.roleIds.cashier as string)), PG.permissionDenied);
    await write(shop.owner, (tx) => setStaffRole(tx, cashier.staffId, shop.roleIds.owner as string));
  });

  it("nobody below staff:manage can change a role, and a role holding keys you lack cannot be given out", async () => {
    const shop = await makeShop("promote2");
    const manager = await person(shop, "manager");
    const cashier = await person(shop, "cashier");
    const viewer = await person(shop, "viewer");
    await expectPgError(write(cashier.ctx, (tx) => setStaffRole(tx, viewer.staffId, shop.roleIds.cashier as string)), PG.permissionDenied);
    const wide = await customRole(shop, ["sale:create", "role:manage"]);
    await expectPgError(write(manager.ctx, (tx) => setStaffRole(tx, cashier.staffId, wide)), PG.permissionDenied);
    await write(shop.owner, (tx) => setStaffRole(tx, cashier.staffId, wide)); // the owner holds role:manage
    // the manager now cannot touch that person: they hold a key the manager lacks
    await expectPgError(write(manager.ctx, (tx) => setStaffRole(tx, cashier.staffId, shop.roleIds.viewer as string)), PG.permissionDenied);
  });
});

describe("custom roles' permissions", () => {
  it("only role:manage, only custom roles, only keys you hold, never the role you hold", async () => {
    const shop = await makeShop("roleperm");
    const manager = await person(shop, "manager");
    const custom = await customRole(shop, ["sale:create"]);
    const grant = (ctx: RlsContext, roleId: string, key: string, granted = true) => write(ctx, (tx) => setRolePermission(tx, { roleId, key, granted }));

    await expectPgError(grant(manager.ctx, custom, "sale:view"), PG.permissionDenied); // a manager lacks role:manage
    await expectPgError(grant(shop.owner, shop.roleIds.cashier as string, "sale:void"), PG.permissionDenied); // system roles: console only
    await grant(shop.owner, custom, "sale:view");
    await grant(shop.owner, custom, "sale:view"); // again: no change, no error
    const rows = await admin`select permission_key from app.role_permissions where role_id = ${custom} order by 1`;
    expect(rows.map((r) => r.permission_key)).toEqual(["sale:create", "sale:view"]);
    await grant(shop.owner, custom, "sale:create", false);
    expect((await admin`select 1 from app.role_permissions where role_id = ${custom}`).length).toBe(1);
    await expect(grant(shop.owner, custom, "nope:nope")).rejects.toBeInstanceOf(TypeError);
    await expectPgError(grant(shop.owner, newId(), "sale:view"), PG.checkViolation);

    // a person with role:manage in a custom role
    const editor = await customRole(shop, ["role:manage", "sale:create", "product:view"]);
    const other = await customRole(shop, ["product:view"]);
    const { ctx } = await personWithRole(shop, editor);
    await grant(ctx, other, "sale:create"); // held: fine
    await expectPgError(grant(ctx, other, "sale:void"), PG.permissionDenied); // not held
    await expectPgError(grant(ctx, other, "sale:void", false), PG.permissionDenied); // nor may they remove it
    await expectPgError(grant(ctx, editor, "sale:create", false), PG.permissionDenied); // their own role
    await expectPgError(grant(ctx, editor, "product:view"), PG.permissionDenied);
  });

  it("a key the person holds only through an allow can be passed on; one they have denied cannot", async () => {
    const shop = await makeShop("roleperm2");
    const editor = await customRole(shop, ["role:manage"]);
    const other = await customRole(shop, []);
    const { staffId, ctx } = await personWithRole(shop, editor);
    const grant = (key: string) => write(ctx, (tx) => setRolePermission(tx, { roleId: other, key, granted: true }));
    await expectPgError(grant("sale:create"), PG.permissionDenied);
    await write(shop.owner, (tx) => setOverride(tx, { staffId, key: "sale:create", effect: "allow", reason: "needs it" }));
    await grant("sale:create");
    await write(shop.owner, (tx) => setOverride(tx, { staffId, key: "sale:create", effect: "deny", reason: "withdrawn" }));
    await expectPgError(grant("sale:create"), PG.permissionDenied);
  });
});

describe("personal overrides", () => {
  it("an allow adds a key the role lacks; a deny removes one it has; the owner can be denied too", async () => {
    const shop = await makeShop("override");
    const cashier = await person(shop, "cashier");
    await write(shop.owner, (tx) => setOverride(tx, { staffId: cashier.staffId, key: "sale:void", effect: "allow", reason: "trusted" }));
    await write(shop.owner, (tx) => setOverride(tx, { staffId: cashier.staffId, key: "sale:create", effect: "deny", reason: "on probation" }));
    const keys = await perms(shop.owner, cashier.staffId);
    expect(keys.has("sale:void")).toBe(true);
    expect(keys.has("sale:create")).toBe(false);
    expect(keys.has("sale:view")).toBe(true);

    const second = await person(shop, "owner");
    await write(shop.owner, (tx) => setOverride(tx, { staffId: second.staffId, key: "refund:create", effect: "deny", reason: "dispute" }));
    expect((await perms(shop.owner, second.staffId)).has("refund:create")).toBe(false);
    expect((await perms(shop.owner, second.staffId)).has("sale:void")).toBe(true);
  });

  it("changing an override replaces it (one per person and key) and records who and why", async () => {
    const shop = await makeShop("override2");
    const cashier = await person(shop, "cashier");
    await write(shop.owner, (tx) => setOverride(tx, { staffId: cashier.staffId, key: "sale:void", effect: "allow", reason: "first" }));
    await write(shop.owner, (tx) => setOverride(tx, { staffId: cashier.staffId, key: "sale:void", effect: "deny", reason: "second" }));
    const rows = await admin`select effect, reason, granted_by from app.staff_permission_overrides where staff_id = ${cashier.staffId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ effect: "deny", reason: "second", granted_by: shop.ownerId });
    const entries = await admin`select actor_id, after_data from audit.log where tenant_id = ${shop.tenantId} and table_name = 'app.staff_permission_overrides' order by seq`;
    expect(entries.length).toBe(2);
    expect(entries.every((e) => e.actor_id === shop.ownerId)).toBe(true);
    expect(JSON.stringify(entries)).toContain("second");
  });

  it("you cannot give yourself anything, and a reason is required", async () => {
    const shop = await makeShop("override3");
    const manager = await person(shop, "manager");
    const cashier = await person(shop, "cashier");
    await expectPgError(write(manager.ctx, (tx) => setOverride(tx, { staffId: manager.staffId, key: "role:manage", effect: "allow", reason: "me" })), PG.permissionDenied);
    await expectPgError(write(shop.owner, (tx) => setOverride(tx, { staffId: shop.ownerId, key: "sale:void", effect: "deny", reason: "me" })), PG.permissionDenied);
    for (const reason of ["", "   "]) {
      await expectPgError(write(shop.owner, (tx) => setOverride(tx, { staffId: cashier.staffId, key: "sale:void", effect: "allow", reason })), PG.checkViolation);
    }
    await expectPgError(write(shop.owner, (tx) => tx.execute(sql`select app.set_override(${cashier.staffId}::uuid, 'sale:void', 'maybe', 'x')`)), PG.checkViolation);
    await expectPgError(write(shop.owner, (tx) => setOverride(tx, { staffId: newId(), key: "sale:void", effect: "allow", reason: "x" })), PG.checkViolation);
  });

  it("you can only allow keys you hold; denying needs only that the person is not above you", async () => {
    const shop = await makeShop("override4");
    const manager = await person(shop, "manager");
    const cashier = await person(shop, "cashier");
    const otherOwner = await person(shop, "owner");
    await expectPgError(write(manager.ctx, (tx) => setOverride(tx, { staffId: cashier.staffId, key: "role:manage", effect: "allow", reason: "x" })), PG.permissionDenied);
    await write(manager.ctx, (tx) => setOverride(tx, { staffId: cashier.staffId, key: "sale:void", effect: "allow", reason: "x" }));
    await write(manager.ctx, (tx) => setOverride(tx, { staffId: cashier.staffId, key: "role:manage", effect: "deny", reason: "x" }));
    await expectPgError(write(manager.ctx, (tx) => setOverride(tx, { staffId: otherOwner.staffId, key: "sale:void", effect: "deny", reason: "x" })), PG.permissionDenied);
    // a cashier has no staff:manage at all
    await expectPgError(write(cashier.ctx, (tx) => setOverride(tx, { staffId: shop.ownerId, key: "sale:void", effect: "deny", reason: "x" })), PG.permissionDenied);
  });

  it("removing a deny gives the key back, so it needs the key; removing an allow does not", async () => {
    const shop = await makeShop("override5");
    const manager = await person(shop, "manager");
    const cashier = await person(shop, "cashier");
    await write(shop.owner, (tx) => setOverride(tx, { staffId: cashier.staffId, key: "role:manage", effect: "deny", reason: "x" }));
    await expectPgError(write(manager.ctx, (tx) => removeOverride(tx, { staffId: cashier.staffId, key: "role:manage" })), PG.permissionDenied);
    await write(shop.owner, (tx) => setOverride(tx, { staffId: cashier.staffId, key: "sale:void", effect: "allow", reason: "x" }));
    expect(await write(manager.ctx, (tx) => removeOverride(tx, { staffId: cashier.staffId, key: "sale:void" }))).toBe(true);
    expect(await write(manager.ctx, (tx) => removeOverride(tx, { staffId: cashier.staffId, key: "sale:void" }))).toBe(false);
    expect(await write(shop.owner, (tx) => removeOverride(tx, { staffId: cashier.staffId, key: "role:manage" }))).toBe(true);
  });
});

describe("the last owner can never be removed", () => {
  const ownerCount = async (shop: Shop) => {
    const [row] = await admin`select count(*)::int as n from app.staff s join app.roles r on r.tenant_id = s.tenant_id and r.id = s.role_id where s.tenant_id = ${shop.tenantId} and r.key = 'owner' and s.status in ('active', 'invited')`;
    return row?.n as number;
  };
  const refused = (statement: Promise<unknown>) => expectPgError(statement.then(() => undefined), "RT008");
  const refusedRole = (statement: Promise<unknown>) => expectPgError(statement.then(() => undefined), PG.checkViolation);

  it("not by suspending, archiving, demoting or deleting, even with the owner login", async () => {
    const shop = await makeShop("lastowner");
    const cashier = await person(shop, "cashier");
    await refused(admin`update app.staff set status = 'suspended' where id = ${shop.ownerId}`);
    await refused(admin`update app.staff set status = 'archived' where id = ${shop.ownerId}`);
    await refused(admin`update app.staff set role_id = ${shop.roleIds.cashier as string} where id = ${shop.ownerId}`);
    await refused(admin`delete from app.staff where id = ${shop.ownerId}`);
    await refused(admin`update app.staff set role_id = ${shop.roleIds.cashier as string}, status = 'suspended' where id = ${shop.ownerId}`);
    expect(await ownerCount(shop)).toBe(1);
    // other people can come and go
    await admin`update app.staff set status = 'suspended' where id = ${cashier.staffId}`;
    // ...and the owner can be edited without losing the role
    await admin`update app.staff set display_name = 'Renamed owner', status = 'active' where id = ${shop.ownerId}`;
  });

  it("with a second owner, one may step down (and then the other is the last)", async () => {
    const shop = await makeShop("lastowner2");
    const second = await person(shop, "owner");
    await write(shop.owner, (tx) => setStaffRole(tx, second.staffId, shop.roleIds.manager as string));
    expect(await ownerCount(shop)).toBe(1);
    await refused(admin`update app.staff set status = 'suspended' where id = ${shop.ownerId}`);
    // hand ownership over: promote first, then demote
    await write(shop.owner, (tx) => setStaffRole(tx, second.staffId, shop.roleIds.owner as string));
    await admin`update app.staff set role_id = ${shop.roleIds.cashier as string} where id = ${shop.ownerId}`;
    expect(await ownerCount(shop)).toBe(1);
  });

  it("an owner who has not yet accepted the invitation still counts, so the shop is never left empty", async () => {
    const email = `solo-${suffix()}@example.com`;
    const shop = await provisionTenant(admin, { slug: `solo-${suffix()}`, displayName: { en: "Solo" }, industry: "other", planKey: "pro", owner: { email, displayName: "Invited owner" } });
    await refused(admin`update app.staff set status = 'archived' where id = ${shop.ownerInvite?.staffId as string}`);
    await refused(admin`delete from app.staff where id = ${shop.ownerInvite?.staffId as string}`);
  });

  it("two owners stepping down at the very same moment cannot both succeed", async () => {
    for (let round = 0; round < 3; round++) {
      const shop = await makeShop(`race${round}`);
      const second = await person(shop, "owner");
      const results = await Promise.allSettled([
        admin`update app.staff set status = 'suspended' where id = ${shop.ownerId}`,
        admin`update app.staff set status = 'suspended' where id = ${second.staffId}`,
      ]);
      expect(results.filter((r) => r.status === "fulfilled"), `round ${round}`).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(pgCode(rejected.reason)).toBe("RT008");
      expect(await ownerCount(shop)).toBe(1);
    }
  });

  it("the owner role itself cannot be deleted, renamed or archived", async () => {
    const shop = await makeShop("ownerrole");
    await refusedRole(admin`delete from app.roles where id = ${shop.roleIds.owner as string}`);
    await refusedRole(admin`update app.roles set key = 'chief' where id = ${shop.roleIds.owner as string}`);
    await refusedRole(admin`update app.roles set archived_at = now() where id = ${shop.roleIds.owner as string}`);
    await admin`update app.roles set name = '{"en": "Proprietor"}'::jsonb where id = ${shop.roleIds.owner as string}`; // a display name may change
  });
});

describe("the device functions ask for real permissions", () => {
  const pairingCode = (ctx: RlsContext, branchId: string) => write(ctx, (tx) => createPairingCode(tx, { branchId, devicePepper: "Zx6cVb3nMq8wEr1tYu4iOp7aSd2fGh5j" }));

  it("device:manage decides: a manager has it, a cashier does not, an allow gives it, a deny takes it away", async () => {
    const shop = await makeShop("devperm");
    const manager = await person(shop, "manager");
    const cashier = await person(shop, "cashier");
    await pairingCode(manager.ctx, shop.branchId);
    await expectPgError(pairingCode(cashier.ctx, shop.branchId), PG.permissionDenied);
    await write(shop.owner, (tx) => setOverride(tx, { staffId: cashier.staffId, key: "device:manage", effect: "allow", reason: "opens the shop" }));
    await pairingCode(cashier.ctx, shop.branchId);
    await write(shop.owner, (tx) => setOverride(tx, { staffId: manager.staffId, key: "device:manage", effect: "deny", reason: "x" }));
    await expectPgError(pairingCode(manager.ctx, shop.branchId), PG.permissionDenied);
    expect(await hmacHex("a".repeat(32), "x")).toHaveLength(64);
  });
});

describe("what the audit log records about permission changes", () => {
  it("role changes, grants and overrides are all in the log, by whom", async () => {
    const shop = await makeShop("audit");
    const cashier = await person(shop, "cashier");
    const custom = await customRole(shop, []);
    const [mark] = await admin`select coalesce(max(seq), 0)::int as seq from audit.log where tenant_id = ${shop.tenantId}`;
    await write(shop.owner, (tx) => setStaffRole(tx, cashier.staffId, shop.roleIds.manager as string));
    await write(shop.owner, (tx) => setRolePermission(tx, { roleId: custom, key: "sale:view", granted: true }));
    await write(shop.owner, (tx) => setOverride(tx, { staffId: cashier.staffId, key: "sale:void", effect: "deny", reason: "audit me" }));
    const rows = await admin`select table_name, event_key, actor_id from audit.log where tenant_id = ${shop.tenantId} and actor_id = ${shop.ownerId} and seq > ${mark?.seq as number} order by seq`;
    expect(rows.map((r) => `${r.table_name}:${r.event_key}`)).toEqual([
      "app.staff:row.update",
      "app.role_permissions:row.insert",
      "app.staff_permission_overrides:row.insert",
    ]);
    const [role] = await admin`select before_data, after_data from audit.log where tenant_id = ${shop.tenantId} and table_name = 'app.staff' and event_key = 'row.update' and row_id = ${cashier.staffId}`;
    expect(role?.before_data.role_id).toBe(shop.roleIds.cashier);
    expect(role?.after_data.role_id).toBe(shop.roleIds.manager);
    expect(PERMISSION_KEYS.length).toBeGreaterThan(40);
    const _typed: PermissionKey = "sale:view";
    expect(_typed).toBe("sale:view");
  });
});

describe("each rule also holds on its own (not only through the function that normally reaches it)", () => {
  it("an unknown role is never 'covered' by anyone", async () => {
    const shop = await makeShop("cover");
    const covers = await admin.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${shop.tenantId}, true), set_config('app.staff_id', ${shop.ownerId}, true)`;
      const [row] = await tx`select private.actor_covers_role(${newId()}::uuid) as ok`;
      return row?.ok;
    });
    expect(covers).toBe(false);
  });

  it("an owner who has only been invited still counts, so the active owner may step down", async () => {
    const shop = await makeShop("invitedowner");
    await admin`insert into app.staff (id, tenant_id, display_name, role_id, status, invite_email, invite_token_hash, invite_expires_at)
                values (${newId()}, ${shop.tenantId}, 'Invited owner', ${shop.roleIds.owner as string}, 'invited', 'later@example.com', ${randomBytes(16).toString("hex")}, now() + interval '7 days')`;
    await admin`update app.staff set status = 'suspended' where id = ${shop.ownerId}`;
  });

  it("someone without staff:manage cannot add a person even with a role they fully cover", async () => {
    const shop = await makeShop("nomanage");
    const cashier = await person(shop, "cashier");
    const modest = await customRole(shop, ["sale:view"]);
    await expectPgError(write(cashier.ctx, (tx) => createStaff(tx, { id: newId(), displayName: "Nope", roleId: modest })), PG.permissionDenied);
  });

  it("removing an override is refused for someone above you, and for someone without staff:manage", async () => {
    const shop = await makeShop("removeabove");
    const manager = await person(shop, "manager");
    const cashier = await person(shop, "cashier");
    const otherOwner = await person(shop, "owner");
    await write(shop.owner, (tx) => setOverride(tx, { staffId: otherOwner.staffId, key: "sale:void", effect: "allow", reason: "x" }));
    await expectPgError(write(manager.ctx, (tx) => removeOverride(tx, { staffId: otherOwner.staffId, key: "sale:void" })), PG.permissionDenied);
    await expectPgError(write(cashier.ctx, (tx) => removeOverride(tx, { staffId: manager.staffId, key: "sale:void" })), PG.permissionDenied);
    expect((await admin`select 1 from app.staff_permission_overrides where staff_id = ${otherOwner.staffId}`).length).toBe(1);
  });

  it("recording a PIN approval re-checks the approver's permission itself", async () => {
    const shop = await makeShop("finishperm");
    const cashier = await person(shop, "cashier");
    const other = await person(shop, "cashier");
    await admin`update app.staff set pin_hash = 'pbkdf2-sha256$1$AAAA$AAAA' where id = ${other.staffId}`;
    await expectPgError(
      write(cashier.ctx, (tx) => tx.execute(sql`select app.step_up_finish(${newId()}::uuid, ${other.staffId}::uuid, 'refund:create', null)`)),
      "RT007",
    );
  });
});
