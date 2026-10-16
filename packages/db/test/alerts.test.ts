import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALERT_CATEGORIES, ALERT_STATUSES, canTransitionAlert } from "@retail/core";
import { countOpenAlerts, listAlerts, raiseAlert, setAlertStatus } from "../src/alerts";
import { createPairingCode, pairDevice, pinSignIn, setStaffPin, type Peppers } from "../src/devices";
import { PermissionDeniedError } from "../src/permissions";
import { createTenantDb, type RlsContext, type TenantDb } from "../src/rls";
import { acceptInvite, startSession } from "../src/sign-in";
import { provisionTenant } from "../src/tenants";
import { PG, adminSql, appUrl, expectPgError, newId } from "./helpers";

const admin: Sql = adminSql(4);
let db: TenantDb;

beforeAll(() => {
  db = createTenantDb(appUrl(), { max: 10 });
});
afterAll(async () => {
  await db.close();
  await admin.end();
});

const PEPPERS: Peppers = { devicePepper: "Zx6cVb3nMq8wEr1tYu4iOp7aSd2fGh5j", pinPepper: "Qw8eRt5yUi2oPa7sDf4gHj1kLz9xCv3b" };
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

async function person(shop: Shop, roleKey: "manager" | "cashier" | "viewer") {
  const staffId = newId();
  const sessionId = newId();
  await admin`insert into app.staff (id, tenant_id, display_name, role_id, status) values (${staffId}, ${shop.tenantId}, ${`${roleKey} ${suffix()}`}, ${shop.roleIds[roleKey] as string}, 'active')`;
  await admin`insert into app.staff_sessions (id, tenant_id, staff_id, method, expires_at) values (${sessionId}, ${shop.tenantId}, ${staffId}, 'password', now() + interval '1 day')`;
  return { staffId, ctx: { tenantId: shop.tenantId, staffId, sessionId } as RlsContext };
}

/** A paired till and a cashier with a PIN on it. */
async function tillWithCashier(shop: Shop) {
  const cashier = await person(shop, "cashier");
  await db.rls(shop.owner, (tx) => setStaffPin(tx, { staffId: cashier.staffId, pin: "4829", pinPepper: PEPPERS.pinPepper, iterations: 1000 }), { write: true });
  const { code } = await db.rls(shop.owner, (tx) => createPairingCode(tx, { branchId: shop.branchId, devicePepper: PEPPERS.devicePepper }), { write: true });
  const paired = await db.device((tx) => pairDevice(tx, { code, name: "Counter 1", kind: "pos", rateKey: `rk-${suffix()}`, devicePepper: PEPPERS.devicePepper }));
  if (!paired.ok) throw new Error("pairing failed");
  return { cashier, device: paired };
}
const wrongPin = (token: string, staffId: string) => db.device((tx) => pinSignIn(tx, { deviceToken: token, staffId, pin: "0000", peppers: PEPPERS }));

const write = <T>(ctx: RlsContext, fn: (tx: Parameters<Parameters<TenantDb["rls"]>[1]>[0]) => Promise<T>) => db.rls(ctx, fn, { write: true });
const list = (ctx: RlsContext, input: Parameters<typeof listAlerts>[1] = {}) => db.rls(ctx, (tx) => listAlerts(tx, input));

describe("a PIN lockout is an alert", () => {
  it("five wrong PINs raise one alert for the person and one for the till, and nothing in them is secret", async () => {
    const shop = await makeShop("lockalert");
    const { cashier, device } = await tillWithCashier(shop);
    expect(await list(shop.owner)).toHaveLength(0);
    for (let i = 0; i < 4; i++) await wrongPin(device.deviceToken, cashier.staffId);
    expect(await list(shop.owner), "four failures are not an alert yet").toHaveLength(0);
    await wrongPin(device.deviceToken, cashier.staffId);

    const alerts = await list(shop.owner);
    expect(alerts.map((a) => a.ruleKey).sort()).toEqual(["pin.device_locked", "pin.staff_locked"]);
    const person = alerts.find((a) => a.ruleKey === "pin.staff_locked");
    const till = alerts.find((a) => a.ruleKey === "pin.device_locked");
    expect(person).toMatchObject({ category: "suspicion", severity: 3, status: "new", entityType: "staff", entityId: cashier.staffId, branchId: shop.branchId });
    expect(till).toMatchObject({ category: "suspicion", severity: 4, status: "new", entityType: "device", entityId: device.deviceId, branchId: shop.branchId });
    expect(person?.payload).toMatchObject({ staff_id: cashier.staffId, device_id: device.deviceId });
    // random ids and timestamps can contain any digits, so take them out before looking for the PIN
    const readable = JSON.stringify(alerts).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "").replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "");
    expect(readable).not.toMatch(/pbkdf2|0000|4829|hash/i);

    // more attempts while locked do not pile up alerts
    for (let i = 0; i < 3; i++) await wrongPin(device.deviceToken, cashier.staffId);
    expect(await list(shop.owner)).toHaveLength(2);
  });

  it("a lock on a different till is a different alert, and a person's lock alone does not alert the till", async () => {
    const shop = await makeShop("lockalert2");
    const { cashier, device } = await tillWithCashier(shop);
    await admin`update app.devices set pin_failed_count = 0 where id = ${device.deviceId}`;
    await admin`update app.staff set pin_failed_count = 4 where id = ${cashier.staffId}`;
    await wrongPin(device.deviceToken, cashier.staffId);
    const keys = (await list(shop.owner)).map((a) => a.ruleKey);
    expect(keys).toEqual(["pin.staff_locked"]);
  });

  it("is the shop's own: another shop sees none of it", async () => {
    const a = await makeShop("lockiso-a");
    const b = await makeShop("lockiso-b");
    const { cashier, device } = await tillWithCashier(a);
    for (let i = 0; i < 5; i++) await wrongPin(device.deviceToken, cashier.staffId);
    expect((await list(a.owner)).length).toBe(2);
    expect(await list(b.owner)).toHaveLength(0);
    expect(Object.values(await db.rls(b.owner, (tx) => countOpenAlerts(tx))).reduce((x, y) => x + y, 0)).toBe(0);
  });
});

describe("raising an alert", () => {
  it("the rule fixes the category and severity, and a replay of the same id raises it once", async () => {
    const shop = await makeShop("raise");
    const id = newId();
    const entity = newId();
    for (let i = 0; i < 3; i++) {
      await write(shop.owner, (tx) => raiseAlert(tx, { ruleKey: "pin.device_locked", id, branchId: shop.branchId, entityType: "device", entityId: entity, payload: { note: "hello" } }));
    }
    const alerts = await list(shop.owner);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ id, category: "suspicion", severity: 4, ruleKey: "pin.device_locked", entityType: "device", entityId: entity, payload: { note: "hello" } });
  });

  it("any active staff member's request can raise one; someone not active cannot", async () => {
    const shop = await makeShop("raise2");
    const cashier = await person(shop, "cashier");
    await write(cashier.ctx, (tx) => raiseAlert(tx, { ruleKey: "pin.staff_locked" }));
    expect((await list(shop.owner)).length).toBe(1);
    await admin`update app.staff set status = 'suspended' where id = ${cashier.staffId}`;
    await expect(write(cashier.ctx, (tx) => raiseAlert(tx, { ruleKey: "pin.staff_locked" }))).rejects.toBeDefined(); // the session is over
  });

  it("the database refuses malformed alerts even when called directly", async () => {
    const shop = await makeShop("raise3");
    const call = (args: { rule?: string; category?: string; severity?: number; entityType?: string | null; entityId?: string | null; payload?: string; branch?: string | null }) =>
      write(shop.owner, (tx) =>
        tx.execute(sql`select app.raise_alert(${newId()}::uuid, ${args.rule ?? "test.note"}, ${args.category ?? "info"}, ${args.severity ?? 1}::int,
          ${args.branch ?? null}::uuid, ${args.entityType ?? null}, ${args.entityId ?? null}::uuid, ${args.payload ?? "{}"}::text::jsonb)`),
      );
    await call({});
    await expectPgError(call({ category: "gossip" }), PG.checkViolation);
    await expectPgError(call({ severity: 0 }), PG.checkViolation);
    await expectPgError(call({ severity: 6 }), PG.checkViolation);
    await expectPgError(call({ rule: "Not A Rule" }), PG.checkViolation);
    await expectPgError(call({ rule: "norule" }), PG.checkViolation);
    await expectPgError(call({ payload: "[]" }), PG.checkViolation);
    await expectPgError(call({ payload: '"text"' }), PG.checkViolation);
    await expectPgError(call({ entityType: "staff" }), PG.checkViolation); // a type without an id
    await expectPgError(call({ entityId: newId() }), PG.checkViolation); // an id without a type
    const other = await makeShop("raise3-other");
    await expectPgError(call({ branch: other.branchId }), PG.foreignKeyViolation);
  });

  it("a missing payload is stored as an empty one", async () => {
    const shop = await makeShop("nopayload");
    const id = newId();
    await write(shop.owner, (tx) => tx.execute(sql`select app.raise_alert(${id}::uuid, 'test.note', 'info', 1::int, null, null, null, null)`));
    const [row] = await admin`select payload from app.alerts where id = ${id}`;
    expect(row?.payload).toEqual({});
  });

  it("the function itself refuses anyone who is not an active member of the shop", async () => {
    const shop = await makeShop("inactiveraise");
    const cashier = await person(shop, "cashier");
    await admin`update app.staff set status = 'suspended' where id = ${cashier.staffId}`;
    const attempt = (staffId: string) =>
      admin.begin(async (tx) => {
        await tx`set local role authenticated`;
        await tx`select set_config('app.tenant_id', ${shop.tenantId}, true), set_config('app.staff_id', ${staffId}, true)`;
        await tx`select app.raise_alert(${newId()}::uuid, 'test.note', 'info', 1::int, null, null, null, null)`;
      });
    await expectPgError(attempt(cashier.staffId), PG.permissionDenied);
    await expectPgError(attempt(newId()), PG.permissionDenied);
    await attempt(shop.ownerId);
  });

  it("nothing writes the alerts table directly, not even the owner of the shop", async () => {
    const shop = await makeShop("direct");
    await write(shop.owner, (tx) => raiseAlert(tx, { ruleKey: "pin.staff_locked" }));
    const refuse = (statement: ReturnType<typeof sql>) => expectPgError(write(shop.owner, (tx) => tx.execute(statement)), PG.permissionDenied);
    await refuse(sql`insert into app.alerts (id, tenant_id, category, rule_key, severity) values (${newId()}, ${shop.tenantId}, 'info', 'a.b', 1)`);
    await refuse(sql`update app.alerts set status = 'dismissed' where tenant_id = ${shop.tenantId}`);
    await refuse(sql`delete from app.alerts where tenant_id = ${shop.tenantId}`);
    expect((await list(shop.owner)).length).toBe(1);
  });
});

describe("reading alerts", () => {
  it("needs alert:view: a manager and a viewer may, a cashier may not", async () => {
    const shop = await makeShop("view");
    const manager = await person(shop, "manager");
    const viewer = await person(shop, "viewer");
    const cashier = await person(shop, "cashier");
    await write(shop.owner, (tx) => raiseAlert(tx, { ruleKey: "pin.staff_locked" }));
    expect(await list(manager.ctx)).toHaveLength(1);
    expect(await list(viewer.ctx)).toHaveLength(1);
    await expect(list(cashier.ctx)).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(db.rls(cashier.ctx, (tx) => countOpenAlerts(tx))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("filters by status and category, pages, and counts the open ones per category", async () => {
    const shop = await makeShop("filter");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await write(shop.owner, (tx) => raiseAlert(tx, { ruleKey: i % 2 === 0 ? "pin.staff_locked" : "pin.device_locked" })));
    }
    await admin`insert into app.alerts (id, tenant_id, category, rule_key, severity) values (${newId()}, ${shop.tenantId}, 'info', 'test.note', 1), (${newId()}, ${shop.tenantId}, 'fraud', 'test.fraud', 5)`;
    await write(shop.owner, (tx) => setAlertStatus(tx, { alertId: ids[0] as string, status: "ack" }));
    await write(shop.owner, (tx) => setAlertStatus(tx, { alertId: ids[1] as string, status: "dismissed", note: "fine" }));

    expect(await list(shop.owner)).toHaveLength(6); // open: new + ack
    expect((await list(shop.owner, { statuses: ["dismissed"] })).map((a) => a.id)).toEqual([ids[1]]);
    expect(await list(shop.owner, { statuses: ["new", "ack", "resolved", "dismissed"] })).toHaveLength(7);
    expect(await list(shop.owner, { categories: ["fraud"] })).toHaveLength(1);
    expect(await list(shop.owner, { categories: ["message"] })).toHaveLength(0);
    expect(await list(shop.owner, { limit: 2 })).toHaveLength(2);
    const page1 = await list(shop.owner, { limit: 3 });
    const page2 = await list(shop.owner, { limit: 3, offset: 3 });
    expect(new Set([...page1, ...page2].map((a) => a.id)).size).toBe(6);
    expect((await list(shop.owner, { limit: 9999 })).length).toBe(6);
    expect(await list(shop.owner, { limit: -5 })).toHaveLength(1);

    const counts = await db.rls(shop.owner, (tx) => countOpenAlerts(tx));
    expect(counts).toEqual({ fraud: 1, suspicion: 4, error: 0, alert: 0, message: 0, info: 1 });
    expect(Object.keys(counts).sort()).toEqual([...ALERT_CATEGORIES].sort());
  });

  it("lists the newest first", async () => {
    const shop = await makeShop("order");
    const first = newId();
    await admin`insert into app.alerts (id, tenant_id, created_at, category, rule_key, severity) values (${first}, ${shop.tenantId}, now() - interval '1 hour', 'info', 'test.note', 1)`;
    const second = await write(shop.owner, (tx) => raiseAlert(tx, { ruleKey: "pin.staff_locked" }));
    expect((await list(shop.owner)).map((a) => a.id)).toEqual([second, first]);
  });
});

describe("closing alerts", () => {
  const raise = (shop: Shop) => write(shop.owner, (tx) => raiseAlert(tx, { ruleKey: "pin.staff_locked" }));
  const row = async (id: string) => (await admin`select status, assignee_staff_id, resolution_note, resolved_by, resolved_at from app.alerts where id = ${id}`)[0];

  it("acknowledging assigns the person; resolving records who, when and the note", async () => {
    const shop = await makeShop("close");
    const manager = await person(shop, "manager");
    const id = await raise(shop);
    await write(manager.ctx, (tx) => setAlertStatus(tx, { alertId: id, status: "ack" }));
    expect(await row(id)).toMatchObject({ status: "ack", assignee_staff_id: manager.staffId, resolved_at: null, resolved_by: null });
    await write(shop.owner, (tx) => setAlertStatus(tx, { alertId: id, status: "resolved", note: "  Spoke to the cashier  " }));
    const closed = await row(id);
    expect(closed).toMatchObject({ status: "resolved", resolution_note: "Spoke to the cashier", resolved_by: shop.ownerId, assignee_staff_id: manager.staffId });
    expect(closed?.resolved_at).toBeInstanceOf(Date);
  });

  it("a new alert can be closed straight away, and an empty note is stored as nothing", async () => {
    const shop = await makeShop("close2");
    const id = await raise(shop);
    await write(shop.owner, (tx) => setAlertStatus(tx, { alertId: id, status: "dismissed", note: "   " }));
    expect(await row(id)).toMatchObject({ status: "dismissed", resolution_note: null, resolved_by: shop.ownerId });
  });

  it("only someone with alert:resolve can: not a viewer (who can read), not a cashier", async () => {
    const shop = await makeShop("close3");
    const viewer = await person(shop, "viewer");
    const cashier = await person(shop, "cashier");
    const id = await raise(shop);
    await expectPgError(write(viewer.ctx, (tx) => setAlertStatus(tx, { alertId: id, status: "ack" })), PG.permissionDenied);
    await expectPgError(write(cashier.ctx, (tx) => setAlertStatus(tx, { alertId: id, status: "ack" })), PG.permissionDenied);
    expect((await row(id))?.status).toBe("new");
  });

  it("closed is final, going back is refused, and an unknown alert is refused", async () => {
    const shop = await makeShop("close4");
    const id = await raise(shop);
    await write(shop.owner, (tx) => setAlertStatus(tx, { alertId: id, status: "ack" }));
    await expectPgError(write(shop.owner, (tx) => setAlertStatus(tx, { alertId: id, status: "ack" })), PG.checkViolation);
    await write(shop.owner, (tx) => setAlertStatus(tx, { alertId: id, status: "resolved" }));
    for (const status of ["ack", "resolved", "dismissed"] as const) {
      await expectPgError(write(shop.owner, (tx) => setAlertStatus(tx, { alertId: id, status })), PG.checkViolation);
    }
    await expectPgError(write(shop.owner, (tx) => tx.execute(sql`select app.set_alert_status(${id}::uuid, 'new', null)`)), PG.checkViolation);
    await expectPgError(write(shop.owner, (tx) => setAlertStatus(tx, { alertId: newId(), status: "ack" })), PG.checkViolation);
    expect((await row(id))?.status).toBe("resolved");
  });

  it("one shop cannot close another shop's alert", async () => {
    const a = await makeShop("closeiso-a");
    const b = await makeShop("closeiso-b");
    const id = await raise(a);
    await expectPgError(write(b.owner, (tx) => setAlertStatus(tx, { alertId: id, status: "dismissed" })), PG.checkViolation);
    expect((await row(id))?.status).toBe("new");
  });

  it("the SQL life cycle equals core's for every pair of statuses", async () => {
    for (const from of ALERT_STATUSES) {
      for (const to of ALERT_STATUSES) {
        const [r] = await admin`select private.alert_transition_ok(${from}, ${to}) as ok`;
        expect(r?.ok, `${from} to ${to}`).toBe(canTransitionAlert(from, to));
      }
    }
  });

  it("the audit log records who closed an alert", async () => {
    const shop = await makeShop("closeaudit");
    const id = await raise(shop);
    await write(shop.owner, (tx) => setAlertStatus(tx, { alertId: id, status: "dismissed", note: "false alarm" }));
    const [entry] = await admin`select actor_id, before_data, after_data from audit.log where tenant_id = ${shop.tenantId} and table_name = 'app.alerts' and row_id = ${id} and event_key = 'row.update'`;
    expect(entry?.actor_id).toBe(shop.ownerId);
    expect(entry?.before_data.status).toBe("new");
    expect(entry?.after_data.status).toBe("dismissed");
  });
});
