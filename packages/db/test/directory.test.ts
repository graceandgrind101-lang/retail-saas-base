import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPairingCode, pairDevice, revokeDevice, setStaffPin } from "../src/devices";
import { getStaffMember, listActivity, listDevices, listOverrides, listRoles, listStaff, setStaffStatus } from "../src/directory";
import { PermissionDeniedError, createStaff, setOverride } from "../src/permissions";
import { createTenantDb, type RlsContext, type TenantDb } from "../src/rls";
import { SessionEndedError } from "../src/errors";
import { acceptInvite, startSession } from "../src/sign-in";
import { saveSetting } from "../src/settings";
import { provisionTenant } from "../src/tenants";
import { PG, adminSql, appUrl, expectPgError, newId } from "./helpers";

const admin: Sql = adminSql(4);
let db: TenantDb;
const PEPPERS = { devicePepper: "Zx6cVb3nMq8wEr1tYu4iOp7aSd2fGh5j", pinPepper: "Qw8eRt5yUi2oPa7sDf4gHj1kLz9xCv3b" };

beforeAll(() => {
  db = createTenantDb(appUrl(), { max: 10 });
});
afterAll(async () => {
  await db.close();
  await admin.end();
});

const suffix = () => randomBytes(4).toString("hex");

interface Shop {
  tenantId: string;
  branchId: string;
  roleIds: Record<string, string>;
  owner: RlsContext;
  ownerId: string;
}

async function makeShop(prefix: string): Promise<Shop> {
  const email = `owner-${suffix()}@example.com`;
  const shop = await provisionTenant(admin, { slug: `${prefix}-${suffix()}`, displayName: { en: `Shop ${prefix}` }, industry: "electronics", planKey: "pro", owner: { email, displayName: "Owner Person" } });
  const acct = { authUserId: newId(), email };
  await db.identity(acct, (tx) => acceptInvite(tx, shop.ownerInvite?.token ?? ""));
  const session = await db.identity(acct, (tx) => startSession(tx, { tenantId: shop.tenantId, method: "password" }));
  return { tenantId: shop.tenantId, branchId: shop.branchId, roleIds: shop.roleIds, ownerId: session.staffId, owner: { tenantId: shop.tenantId, staffId: session.staffId, sessionId: session.sessionId } };
}

async function person(shop: Shop, roleKey: "owner" | "manager" | "cashier", name = `${roleKey} ${suffix()}`) {
  const staffId = newId();
  const sessionId = newId();
  await admin`insert into app.staff (id, tenant_id, display_name, role_id, status) values (${staffId}, ${shop.tenantId}, ${name}, ${shop.roleIds[roleKey] as string}, 'active')`;
  await admin`insert into app.staff_sessions (id, tenant_id, staff_id, method, expires_at) values (${sessionId}, ${shop.tenantId}, ${staffId}, 'password', now() + interval '1 day')`;
  return { staffId, name, ctx: { tenantId: shop.tenantId, staffId, sessionId } as RlsContext };
}

const write = <T>(ctx: RlsContext, fn: Parameters<TenantDb["rls"]>[1]) => db.rls(ctx, fn as never, { write: true }) as Promise<T>;
const read = <T>(ctx: RlsContext, fn: Parameters<TenantDb["rls"]>[1]) => db.rls(ctx, fn as never) as Promise<T>;
const status = (ctx: RlsContext, id: string, to: "active" | "suspended" | "archived") => write<void>(ctx, (tx) => setStaffStatus(tx, id, to));
const statusOf = async (id: string) => ((await admin`select status from app.staff where id = ${id}`)[0]?.status as string);

describe("suspending, reinstating and archiving people", () => {
  it("a manager can suspend a cashier (ending their sessions at once) and reinstate them", async () => {
    const shop = await makeShop("status");
    const manager = await person(shop, "manager");
    const cashier = await person(shop, "cashier");
    await status(manager.ctx, cashier.staffId, "suspended");
    expect(await statusOf(cashier.staffId)).toBe("suspended");
    await expect(read(cashier.ctx, (tx) => tx.execute(sql`select 1`))).rejects.toBeInstanceOf(SessionEndedError);
    await status(manager.ctx, cashier.staffId, "active");
    expect(await statusOf(cashier.staffId)).toBe("active");
    await status(manager.ctx, cashier.staffId, "archived");
    expect(await statusOf(cashier.staffId)).toBe("archived");
  });

  it("not yourself, not someone above you, and not without staff:manage", async () => {
    const shop = await makeShop("statusrules");
    const manager = await person(shop, "manager");
    const cashier = await person(shop, "cashier");
    const other = await person(shop, "cashier");
    await expectPgError(status(manager.ctx, manager.staffId, "suspended"), PG.permissionDenied);
    await expectPgError(status(manager.ctx, shop.ownerId, "suspended"), PG.permissionDenied);
    await expectPgError(status(cashier.ctx, other.staffId, "suspended"), PG.permissionDenied);
    expect(await statusOf(shop.ownerId)).toBe("active");
    expect(await statusOf(other.staffId)).toBe("active");
  });

  it("an owner can suspend another owner, but the last owner can never go", async () => {
    const shop = await makeShop("owners");
    const second = await person(shop, "owner");
    await status(shop.owner, second.staffId, "suspended");
    // now the first owner is the only one: the shop's last owner cannot be removed, not even by the platform's own login
    await expectPgError(admin`update app.staff set status = 'suspended' where id = ${shop.ownerId}`.then(() => undefined), "RT008");
    expect(await statusOf(shop.ownerId)).toBe("active");
  });

  it("archived is final, suspending twice is harmless, and nonsense is refused", async () => {
    const shop = await makeShop("final");
    const cashier = await person(shop, "cashier");
    await status(shop.owner, cashier.staffId, "suspended");
    await status(shop.owner, cashier.staffId, "suspended");
    await status(shop.owner, cashier.staffId, "archived");
    await expectPgError(status(shop.owner, cashier.staffId, "active"), PG.checkViolation);
    await expectPgError(write(shop.owner, (tx) => tx.execute(sql`select app.set_staff_status(${cashier.staffId}::uuid, 'banished')`)), PG.checkViolation);
    await expectPgError(write(shop.owner, (tx) => tx.execute(sql`select app.set_staff_status(${cashier.staffId}::uuid, 'invited')`)), PG.checkViolation);
    await expectPgError(status(shop.owner, newId(), "suspended"), PG.checkViolation);
    expect(await statusOf(cashier.staffId)).toBe("archived");
  });

  it("an invitation that was never accepted can be cancelled by archiving it, but not 'activated'", async () => {
    const shop = await makeShop("invite");
    const inviteId = newId();
    await admin`insert into app.staff (id, tenant_id, display_name, role_id, status, invite_email, invite_token_hash, invite_expires_at)
                values (${inviteId}, ${shop.tenantId}, 'Pending person', ${shop.roleIds.cashier as string}, 'invited', 'pending@example.com', ${randomBytes(16).toString("hex")}, now() + interval '7 days')`;
    await expectPgError(status(shop.owner, inviteId, "active"), PG.checkViolation);
    await status(shop.owner, inviteId, "archived");
    const [row] = await admin`select status, invite_token_hash, invite_email, invite_expires_at from app.staff where id = ${inviteId}`;
    expect(row).toMatchObject({ status: "archived", invite_token_hash: null, invite_email: null, invite_expires_at: null });
  });

  it("a direct change of status from the shop's own login is refused", async () => {
    const shop = await makeShop("direct");
    const cashier = await person(shop, "cashier");
    await expectPgError(write(shop.owner, (tx) => tx.execute(sql`update app.staff set status = 'suspended' where id = ${cashier.staffId}`)), PG.permissionDenied);
    await write(shop.owner, (tx) => tx.execute(sql`update app.staff set display_name = 'Renamed' where id = ${cashier.staffId}`)); // other columns are still fine
    expect(await statusOf(cashier.staffId)).toBe("active");
  });
});

describe("the people list", () => {
  it("shows people with their role, status and whether they have a PIN, and never a PIN hash", async () => {
    const shop = await makeShop("list");
    const manager = await person(shop, "manager", "Beza");
    const cashier = await person(shop, "cashier", "Abebe");
    await write(shop.owner, (tx) => setStaffPin(tx, { staffId: cashier.staffId, pin: "4829", pinPepper: PEPPERS.pinPepper, iterations: 1000 }));
    await status(shop.owner, manager.staffId, "suspended");
    const rows = await read<Awaited<ReturnType<typeof listStaff>>>(shop.owner, (tx) => listStaff(tx));
    expect(rows.map((r) => r.name)).toEqual(["Abebe", "Owner Person", "Beza"]); // active first, then suspended; each by name
    expect(rows.find((r) => r.name === "Abebe")).toMatchObject({ roleKey: "cashier", status: "active", hasPin: true, hasAccount: false });
    expect(rows.find((r) => r.name === "Beza")).toMatchObject({ roleKey: "manager", status: "suspended", hasPin: false });
    expect(rows.find((r) => r.name === "Owner Person")).toMatchObject({ roleKey: "owner", hasAccount: true });
    expect(JSON.stringify(rows)).not.toMatch(/pbkdf2|pin_hash|pinHash/);
  });

  it("needs staff:view: a cashier cannot list or open anyone", async () => {
    const shop = await makeShop("listperm");
    const cashier = await person(shop, "cashier");
    await expect(read(cashier.ctx, (tx) => listStaff(tx))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(read(cashier.ctx, (tx) => getStaffMember(tx, shop.ownerId))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(read(cashier.ctx, (tx) => listOverrides(tx, shop.ownerId))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("opens one person, and nobody from another shop", async () => {
    const shop = await makeShop("one");
    const other = await makeShop("one-other");
    const cashier = await person(shop, "cashier", "Solo");
    expect(await read<Awaited<ReturnType<typeof getStaffMember>>>(shop.owner, (tx) => getStaffMember(tx, cashier.staffId))).toMatchObject({ name: "Solo", roleKey: "cashier" });
    expect(await read(other.owner, (tx) => getStaffMember(tx, cashier.staffId))).toBeNull();
    expect(await read((shop.owner), (tx) => getStaffMember(tx, newId()))).toBeNull();
  });

  it("lists a person's personal exceptions with who set them and why", async () => {
    const shop = await makeShop("overrides");
    const cashier = await person(shop, "cashier");
    await write(shop.owner, (tx) => setOverride(tx, { staffId: cashier.staffId, key: "sale:void", effect: "allow", reason: "trusted" }));
    const rows = await read<Awaited<ReturnType<typeof listOverrides>>>(shop.owner, (tx) => listOverrides(tx, cashier.staffId));
    expect(rows).toEqual([{ key: "sale:void", effect: "allow", reason: "trusted", grantedBy: "Owner Person" }]);
  });

  it("offers the roles a person can be given (anyone signed in may read them)", async () => {
    const shop = await makeShop("roles");
    const cashier = await person(shop, "cashier");
    const roles = await read<Awaited<ReturnType<typeof listRoles>>>(cashier.ctx, (tx) => listRoles(tx));
    expect(roles.map((r) => r.key).sort()).toEqual(["cashier", "manager", "owner", "stock_clerk", "viewer"]);
    expect(roles.every((r) => r.isSystem)).toBe(true);
  });
});

async function pairOne(shop: Shop, name: string) {
  const { code } = await write<Awaited<ReturnType<typeof createPairingCode>>>(shop.owner, (tx) => createPairingCode(tx, { branchId: shop.branchId, devicePepper: PEPPERS.devicePepper }));
  const paired = await db.device((tx) => pairDevice(tx, { code, name, kind: "pos", rateKey: `dir-${suffix()}`, devicePepper: PEPPERS.devicePepper }));
  if (!paired.ok) throw new Error("pairing failed");
  return paired;
}

describe("the devices list", () => {
  it("shows connected devices (active first), who connected them, and revoked ones last; needs device:manage", async () => {
    const shop = await makeShop("devices");
    const manager = await person(shop, "manager");
    const cashier = await person(shop, "cashier");
    const a = await pairOne(shop, "Counter 1");
    const b = await pairOne(shop, "Counter 2");
    await write(shop.owner, (tx) => revokeDevice(tx, a.deviceId));
    const rows = await read<Awaited<ReturnType<typeof listDevices>>>(manager.ctx, (tx) => listDevices(tx));
    expect(rows.map((d) => d.name)).toEqual(["Counter 2", "Counter 1"]);
    expect(rows[0]).toMatchObject({ id: b.deviceId, kind: "pos", pairedBy: "Owner Person", revokedAt: null, lockedUntil: null });
    expect(rows[0]?.branchName).toEqual({ en: "Main branch", am: "ዋና ቅርንጫፍ" });
    expect(rows[1]?.revokedAt).toBeInstanceOf(Date);
    await expect(read(cashier.ctx, (tx) => listDevices(tx))).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(JSON.stringify(rows)).not.toMatch(/token/i);
  });

  it("shows only the shop's own devices", async () => {
    const a = await makeShop("devices-a");
    const b = await makeShop("devices-b");
    await pairOne(a, "Mine");
    expect(await read(b.owner, (tx) => listDevices(tx))).toEqual([]);
  });
});

describe("the activity timeline", () => {
  it("names what happened and to whom: people added, devices connected, settings changed", async () => {
    const shop = await makeShop("activity");
    const staffId = newId();
    await write(shop.owner, (tx) => createStaff(tx, { id: staffId, displayName: "Tigist", roleId: shop.roleIds.cashier as string }));
    await pairOne(shop, "Counter 1");
    await write(shop.owner, (tx) => saveSetting(tx, { key: "inventory.low_stock_threshold", value: 9 }));
    const rows = await read<Awaited<ReturnType<typeof listActivity>>>(shop.owner, (tx) => listActivity(tx, { limit: 100 }));
    const find = (table: string, event: string) => rows.find((r) => r.tableName === table && r.eventKey === event);
    expect(find("app.staff", "row.insert")).toMatchObject({ subjectName: "Tigist", actorName: "Owner Person", actorKind: "staff" });
    expect(find("app.devices", "row.insert")).toMatchObject({ subjectName: "Counter 1", actorName: "Owner Person" });
    expect(find("app.device_pairing_codes", "row.insert")).toBeDefined();
    expect(find("app.tenant_settings", "row.insert")).toMatchObject({ subjectName: "inventory.low_stock_threshold", actorName: "Owner Person" });
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1]!.seq).toBeGreaterThan(rows[i]!.seq);
  });

  it("leaves out noise and never shows a secret", async () => {
    const shop = await makeShop("noise");
    const cashier = await person(shop, "cashier");
    await write(shop.owner, (tx) => setStaffPin(tx, { staffId: cashier.staffId, pin: "4829", pinPepper: PEPPERS.pinPepper, iterations: 1000 }));
    await pairOne(shop, "Counter 1"); // uses up a pairing code: an update that is not shown
    await status(shop.owner, cashier.staffId, "suspended"); // ends a session: an update that is not shown
    const rows = await read<Awaited<ReturnType<typeof listActivity>>>(shop.owner, (tx) => listActivity(tx, { limit: 200 }));
    expect(rows.some((r) => r.tableName === "app.staff_sessions" && r.eventKey === "row.update")).toBe(false);
    expect(rows.some((r) => r.tableName === "app.device_pairing_codes" && r.eventKey === "row.update")).toBe(false);
    expect(rows.some((r) => r.tableName === "app.pin_verifications")).toBe(false);
    expect(rows.some((r) => r.tableName === "app.staff_sessions" && r.eventKey === "row.insert")).toBe(true); // sign-ins are shown
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/pbkdf2|[0-9a-f]{64}/); // no PIN hash, token hash or code hash value anywhere
    expect(text).toContain("[redacted]"); // the secret columns are there, as the marker
  });

  it("can be limited to one person or thing, and paged", async () => {
    const shop = await makeShop("about");
    const a = await person(shop, "cashier", "Almaz");
    const b = await person(shop, "cashier", "Biruk");
    await status(shop.owner, a.staffId, "suspended");
    await status(shop.owner, b.staffId, "suspended");
    await status(shop.owner, a.staffId, "active");
    const about = await read<Awaited<ReturnType<typeof listActivity>>>(shop.owner, (tx) => listActivity(tx, { about: a.staffId, limit: 100 }));
    expect(about.length).toBeGreaterThan(0);
    expect(about.every((r) => r.subjectId === a.staffId || r.rowId === a.staffId)).toBe(true);
    expect(about.some((r) => r.subjectName === "Biruk")).toBe(false);

    const all = await read<Awaited<ReturnType<typeof listActivity>>>(shop.owner, (tx) => listActivity(tx, { limit: 200 }));
    const first = await read<Awaited<ReturnType<typeof listActivity>>>(shop.owner, (tx) => listActivity(tx, { limit: 3 }));
    expect(first).toHaveLength(3);
    const next = await read<Awaited<ReturnType<typeof listActivity>>>(shop.owner, (tx) => listActivity(tx, { limit: 3, beforeSeq: first[2]!.seq }));
    expect(next.map((r) => r.seq)).toEqual(all.filter((r) => r.seq < first[2]!.seq).slice(0, 3).map((r) => r.seq));
    expect(await read(shop.owner, (tx) => listActivity(tx, { limit: 0 }))).toHaveLength(1); // clamped to at least one
    expect((await read<unknown[]>(shop.owner, (tx) => listActivity(tx, { limit: 100_000 }))).length).toBeLessThanOrEqual(200);
  });

  it("needs audit:view: a manager may, a cashier may not; and shops cannot see each other's", async () => {
    const a = await makeShop("act-a");
    const b = await makeShop("act-b");
    const manager = await person(a, "manager");
    const cashier = await person(a, "cashier");
    await person(b, "cashier", "Only in B");
    expect((await read<unknown[]>(manager.ctx, (tx) => listActivity(tx))).length).toBeGreaterThan(0);
    await expectPgError(read(cashier.ctx, (tx) => listActivity(tx)), PG.permissionDenied);
    const seenByA = await read<Awaited<ReturnType<typeof listActivity>>>(a.owner, (tx) => listActivity(tx, { limit: 200 }));
    expect(seenByA.some((r) => r.subjectName === "Only in B")).toBe(false);
  });
});
