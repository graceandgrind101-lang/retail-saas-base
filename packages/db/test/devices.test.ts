import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { afterPinFailure, generatePairingCode, hashPin, hmacHex } from "@retail/core";
import { PinTooWeakError, consumeStepUp, createPairingCode, getDeviceInfo, listDeviceStaff, pairDevice, pinSignIn, requestStepUp, revokeDevice, setStaffPin, unlockDevice, type Peppers } from "../src/devices";
import { SessionEndedError, StepUpInvalidError } from "../src/errors";
import { setOverride } from "../src/permissions";
import { createTenantDb, type RlsContext, type TenantDb } from "../src/rls";
import { acceptInvite, startSession } from "../src/sign-in";
import { isShopReadOnlyError } from "../src/tenant-info";
import { provisionTenant } from "../src/tenants";
import { PG, adminSql, appUrl, expectPgError, newId } from "./helpers";

const admin: Sql = adminSql(4);
let db: TenantDb;

beforeAll(() => {
  db = createTenantDb(appUrl(), { max: 12 });
});
afterAll(async () => {
  await db.close();
  await admin.end();
});

const PEPPERS: Peppers = { devicePepper: "Zx6cVb3nMq8wEr1tYu4iOp7aSd2fGh5j", pinPepper: "Qw8eRt5yUi2oPa7sDf4gHj1kLz9xCv3b" };
const FAST = 1000; // PBKDF2 iterations: fast for tests; the real default is exercised in core
const suffix = () => randomBytes(4).toString("hex");

interface Shop {
  tenantId: string;
  branchId: string;
  owner: RlsContext;
  ownerId: string;
}

/** A shop whose owner followed the invitation and is signed in: the real path. */
async function makeShop(prefix: string): Promise<Shop> {
  const email = `owner-${suffix()}@example.com`;
  const shop = await provisionTenant(admin, {
    slug: `${prefix}-${suffix()}`,
    displayName: { en: `Shop ${prefix}` },
    industry: "other",
    planKey: "pro",
    owner: { email, displayName: "Owner Person" },
  });
  const acct = { authUserId: newId(), email };
  await db.identity(acct, (tx) => acceptInvite(tx, shop.ownerInvite?.token ?? ""));
  const session = await db.identity(acct, (tx) => startSession(tx, { tenantId: shop.tenantId, method: "password" }));
  return {
    tenantId: shop.tenantId,
    branchId: shop.branchId,
    ownerId: session.staffId,
    owner: { tenantId: shop.tenantId, staffId: session.staffId, sessionId: session.sessionId },
  };
}

/** An active staff member with no login account (a till person), plus a ready PIN if asked. */
async function addStaff(shop: Shop, roleKey: "manager" | "cashier" | "owner", options: { pin?: string; branchIds?: string[] } = {}) {
  const staffId = newId();
  const [role] = await admin`select id from app.roles where tenant_id = ${shop.tenantId} and key = ${roleKey}`;
  await admin`insert into app.staff (id, tenant_id, display_name, role_id, status, branch_ids)
              values (${staffId}, ${shop.tenantId}, ${`${roleKey} ${suffix()}`}, ${role?.id}, 'active', ${options.branchIds ?? null})`;
  if (options.pin) await setPin(shop, staffId, options.pin);
  return staffId;
}

const setPin = (shop: Shop, staffId: string, pin: string) =>
  db.rls(shop.owner, (tx) => setStaffPin(tx, { staffId, pin, pinPepper: PEPPERS.pinPepper, iterations: FAST }), { write: true });

async function pairNewDevice(shop: Shop, name = "Counter 1") {
  const { code } = await db.rls(shop.owner, (tx) => createPairingCode(tx, { branchId: shop.branchId, devicePepper: PEPPERS.devicePepper }), { write: true });
  const result = await db.device((tx) =>
    pairDevice(tx, { code, name, kind: "pos", userAgent: "test", rateKey: `rk-${suffix()}`, devicePepper: PEPPERS.devicePepper }),
  );
  if (!result.ok) throw new Error(`pairing failed: ${result.reason}`);
  return result;
}

const signIn = (token: string, staffId: string, pin: string) =>
  db.device((tx) => pinSignIn(tx, { deviceToken: token, staffId, pin, peppers: PEPPERS }));

/** A till session for `staffId`, the real way (PIN at a paired device). */
async function tillSession(shop: Shop, device: { deviceToken: string; deviceId: string }, staffId: string, pin: string): Promise<RlsContext> {
  const r = await signIn(device.deviceToken, staffId, pin);
  if (!r.ok) throw new Error(`sign-in failed: ${r.reason}`);
  return { tenantId: shop.tenantId, staffId, sessionId: r.sessionId, deviceId: r.deviceId };
}

const counters = async (table: "staff" | "devices", id: string) => {
  const [row] = await admin`select pin_failed_count as c, pin_locked_until as l from ${admin(`app.${table}`)} where id = ${id}`;
  return { count: row?.c as number, locked: row?.l as Date | null };
};

describe("pairing a device", () => {
  it("an owner makes a one-time code; the new device exchanges it for its secret token, once", async () => {
    const shop = await makeShop("pair");
    const { code, expiresAt } = await db.rls(shop.owner, (tx) => createPairingCode(tx, { branchId: shop.branchId, devicePepper: PEPPERS.devicePepper }), { write: true });
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    const minutes = (expiresAt.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(9);
    expect(minutes).toBeLessThanOrEqual(10);

    const paired = await db.device((tx) => pairDevice(tx, { code: code.toLowerCase(), name: " Counter 1 ", kind: "pos", rateKey: `rk-${suffix()}`, devicePepper: PEPPERS.devicePepper }));
    expect(paired).toMatchObject({ ok: true, tenantId: shop.tenantId, branchId: shop.branchId });
    if (!paired.ok) return;

    const info = await db.device((tx) => getDeviceInfo(tx, { deviceToken: paired.deviceToken, devicePepper: PEPPERS.devicePepper }));
    expect(info).toMatchObject({ deviceId: paired.deviceId, tenantId: shop.tenantId, branchId: shop.branchId, deviceName: "Counter 1" });

    const again = await db.device((tx) => pairDevice(tx, { code, name: "Second", kind: "pos", rateKey: `rk-${suffix()}`, devicePepper: PEPPERS.devicePepper }));
    expect(again).toEqual({ ok: false, reason: "invalid" });
  });

  it("only the HMAC of the code and the token is stored, and neither appears in the audit log", async () => {
    const shop = await makeShop("secrets");
    const { code } = await db.rls(shop.owner, (tx) => createPairingCode(tx, { branchId: shop.branchId, devicePepper: PEPPERS.devicePepper }), { write: true });
    const paired = await db.device((tx) => pairDevice(tx, { code, name: "Till", kind: "pos", rateKey: `rk-${suffix()}`, devicePepper: PEPPERS.devicePepper }));
    if (!paired.ok) throw new Error("pairing failed");
    const [device] = await admin`select token_hash from app.devices where id = ${paired.deviceId}`;
    const [codeRow] = await admin`select code_hash, used_at, used_by_device_id from app.device_pairing_codes where tenant_id = ${shop.tenantId}`;
    expect(device?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(device?.token_hash).not.toContain(paired.deviceToken);
    expect(codeRow?.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(codeRow?.used_by_device_id).toBe(paired.deviceId);
    const leaked = await admin`
      select count(*)::int as n from audit.log
      where tenant_id = ${shop.tenantId}
        and (coalesce(before_data::text, '') || coalesce(after_data::text, '')) like any (array[${"%" + device?.token_hash + "%"}, ${"%" + codeRow?.code_hash + "%"}, ${"%" + paired.deviceToken + "%"}, ${"%" + code.replace("-", "") + "%"}])`;
    expect(leaked[0]?.n).toBe(0);
    const entries = await admin`select after_data from audit.log where tenant_id = ${shop.tenantId} and table_name = 'app.devices' and event_key = 'row.insert'`;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.after_data.token_hash).toBe("[redacted]");
  });

  it("a wrong code, an expired code and a code of an archived branch are all just 'invalid'", async () => {
    const shop = await makeShop("invalid");
    expect(await db.device((tx) => pairDevice(tx, { code: generatePairingCode(), name: "T", kind: "pos", rateKey: `rk-${suffix()}`, devicePepper: PEPPERS.devicePepper }))).toEqual({ ok: false, reason: "invalid" });

    // An already-expired code, inserted directly (a real one cannot be made in the past).
    const code = generatePairingCode();
    await admin`insert into app.device_pairing_codes (id, tenant_id, created_by, created_at, branch_id, code_hash, expires_at)
                values (${newId()}, ${shop.tenantId}, ${shop.ownerId}, now() - interval '11 minutes', ${shop.branchId},
                        ${await hmacHex(PEPPERS.devicePepper, `pairing-code:${code}`)}, now() - interval '1 minute')`;
    expect(await db.device((tx) => pairDevice(tx, { code, name: "T", kind: "pos", rateKey: `rk-${suffix()}`, devicePepper: PEPPERS.devicePepper }))).toEqual({ ok: false, reason: "invalid" });

    const archived = generatePairingCode();
    const [spare] = await admin`insert into app.branches (id, tenant_id, name) values (${newId()}, ${shop.tenantId}, '{"en": "Spare"}'::jsonb) returning id`;
    await admin`insert into app.device_pairing_codes (id, tenant_id, created_by, branch_id, code_hash, expires_at)
                values (${newId()}, ${shop.tenantId}, ${shop.ownerId}, ${spare?.id}, ${await hmacHex(PEPPERS.devicePepper, `pairing-code:${archived}`)}, now() + interval '5 minutes')`;
    await admin`update app.branches set archived_at = now() where id = ${spare?.id}`;
    expect(await db.device((tx) => pairDevice(tx, { code: archived, name: "T", kind: "pos", rateKey: `rk-${suffix()}`, devicePepper: PEPPERS.devicePepper }))).toEqual({ ok: false, reason: "invalid" });
  });

  it("junk (bad shape, empty name, unknown kind) is refused without touching the database", async () => {
    const attempt = (input: Partial<Parameters<typeof pairDevice>[1]>) =>
      db.device((tx) => pairDevice(tx, { code: generatePairingCode(), name: "T", kind: "pos", rateKey: `rk-${suffix()}`, devicePepper: PEPPERS.devicePepper, ...input }));
    expect(await attempt({ code: "nope" })).toEqual({ ok: false, reason: "invalid" });
    expect(await attempt({ name: "   " })).toEqual({ ok: false, reason: "invalid" });
    expect(await attempt({ name: "x".repeat(61) })).toEqual({ ok: false, reason: "invalid" });
    expect(await attempt({ kind: "toaster" as never })).toEqual({ ok: false, reason: "invalid" });
  });

  it("a code dies when the person who made it is suspended, or the shop is paused", async () => {
    const shop = await makeShop("dies");
    const manager = await addStaff(shop, "manager");
    const [role] = await admin`select id from app.roles where tenant_id = ${shop.tenantId} and key = 'manager'`;
    expect(role).toBeDefined();
    const managerSession = newId();
    await admin`insert into app.staff_sessions (id, tenant_id, staff_id, method, expires_at) values (${managerSession}, ${shop.tenantId}, ${manager}, 'password', now() + interval '1 hour')`;
    const ctx: RlsContext = { tenantId: shop.tenantId, staffId: manager, sessionId: managerSession };
    const { code } = await db.rls(ctx, (tx) => createPairingCode(tx, { branchId: shop.branchId, devicePepper: PEPPERS.devicePepper }), { write: true });
    await admin`update app.staff set status = 'suspended' where id = ${manager}`;
    expect(await db.device((tx) => pairDevice(tx, { code, name: "T", kind: "pos", rateKey: `rk-${suffix()}`, devicePepper: PEPPERS.devicePepper }))).toEqual({ ok: false, reason: "invalid" });

    const { code: second } = await db.rls(shop.owner, (tx) => createPairingCode(tx, { branchId: shop.branchId, devicePepper: PEPPERS.devicePepper }), { write: true });
    await admin`update platform.tenants set status = 'paused' where id = ${shop.tenantId}`;
    expect(await db.device((tx) => pairDevice(tx, { code: second, name: "T", kind: "pos", rateKey: `rk-${suffix()}`, devicePepper: PEPPERS.devicePepper }))).toEqual({ ok: false, reason: "invalid" });
    await admin`update platform.tenants set status = 'pilot' where id = ${shop.tenantId}`;
    expect(await db.device((tx) => pairDevice(tx, { code: second, name: "T", kind: "pos", rateKey: `rk-${suffix()}`, devicePepper: PEPPERS.devicePepper }))).toMatchObject({ ok: true });
  });

  it("guessing is capped per caller: the 11th attempt in ten minutes is refused, even for a right code", async () => {
    const shop = await makeShop("cap");
    const rateKey = `rk-${suffix()}`;
    const wrong = () => db.device((tx) => pairDevice(tx, { code: generatePairingCode(), name: "T", kind: "pos", rateKey, devicePepper: PEPPERS.devicePepper }));
    for (let i = 0; i < 10; i++) expect(await wrong()).toEqual({ ok: false, reason: "invalid" });
    expect(await wrong()).toEqual({ ok: false, reason: "rate_limited" });
    const { code } = await db.rls(shop.owner, (tx) => createPairingCode(tx, { branchId: shop.branchId, devicePepper: PEPPERS.devicePepper }), { write: true });
    expect(await db.device((tx) => pairDevice(tx, { code, name: "T", kind: "pos", rateKey, devicePepper: PEPPERS.devicePepper }))).toEqual({ ok: false, reason: "rate_limited" });
    // another caller is unaffected
    expect(await db.device((tx) => pairDevice(tx, { code, name: "T", kind: "pos", rateKey: `rk-${suffix()}`, devicePepper: PEPPERS.devicePepper }))).toMatchObject({ ok: true });
  });

  it("only an owner or manager can make a code, and not in a paused shop", async () => {
    const shop = await makeShop("who");
    const cashier = await addStaff(shop, "cashier", { pin: "4829" });
    const device = await pairNewDevice(shop);
    const ctx = await tillSession(shop, device, cashier, "4829");
    await expectPgError(db.rls(ctx, (tx) => createPairingCode(tx, { branchId: shop.branchId, devicePepper: PEPPERS.devicePepper }), { write: true }), PG.permissionDenied);

    await admin`update platform.tenants set status = 'paused' where id = ${shop.tenantId}`;
    let caught: unknown;
    try {
      await db.rls(shop.owner, (tx) => createPairingCode(tx, { branchId: shop.branchId, devicePepper: PEPPERS.devicePepper }), { write: true });
    } catch (error) {
      caught = error;
    }
    expect(isShopReadOnlyError(caught)).toBe(true);
  });

  it("a code for another shop's branch is refused", async () => {
    const a = await makeShop("bra");
    const b = await makeShop("brb");
    await expectPgError(db.rls(a.owner, (tx) => createPairingCode(tx, { branchId: b.branchId, devicePepper: PEPPERS.devicePepper }), { write: true }), PG.checkViolation);
  });
});

describe("PIN sign-in at a paired device", () => {
  it("works with the right PIN, opens a 12 hour PIN session on that device, and the session is usable", async () => {
    const shop = await makeShop("signin");
    const cashier = await addStaff(shop, "cashier", { pin: "4829" });
    const device = await pairNewDevice(shop);
    const result = await signIn(device.deviceToken, cashier, "4829");
    expect(result).toMatchObject({ ok: true, staffId: cashier, tenantId: shop.tenantId, deviceId: device.deviceId });
    if (!result.ok) return;
    const hours = (result.expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(11.9);
    expect(hours).toBeLessThanOrEqual(12);
    const [row] = await admin`select method, device_id, staff_id from app.staff_sessions where id = ${result.sessionId}`;
    expect(row).toMatchObject({ method: "pin", device_id: device.deviceId, staff_id: cashier });
    const ctx: RlsContext = { tenantId: shop.tenantId, staffId: cashier, sessionId: result.sessionId, deviceId: device.deviceId };
    const rows = await db.rls(ctx, (tx) => tx.execute(sql`select count(*)::int as n from app.branches`));
    expect(rows[0]?.n).toBe(1);
  });

  it("a wrong PIN is returned (not thrown) and the failure is really stored", async () => {
    const shop = await makeShop("wrong");
    const cashier = await addStaff(shop, "cashier", { pin: "4829" });
    const device = await pairNewDevice(shop);
    expect(await signIn(device.deviceToken, cashier, "1111")).toEqual({ ok: false, reason: "wrong_pin" });
    expect(await counters("staff", cashier)).toMatchObject({ count: 1 });
    expect(await counters("devices", device.deviceId)).toMatchObject({ count: 1 });
    expect(await signIn(device.deviceToken, cashier, "12")).toEqual({ ok: false, reason: "wrong_pin" }); // malformed counts too
    expect(await counters("staff", cashier)).toMatchObject({ count: 2 });
    expect(await signIn(device.deviceToken, cashier, "4829")).toMatchObject({ ok: true });
    expect(await counters("staff", cashier)).toMatchObject({ count: 0, locked: null });
    expect(await counters("devices", device.deviceId)).toMatchObject({ count: 0, locked: null });
  });

  it("the fifth wrong PIN locks the person for 15 minutes, even against the right PIN, and records it", async () => {
    const shop = await makeShop("lock");
    const cashier = await addStaff(shop, "cashier", { pin: "4829" });
    const other = await addStaff(shop, "cashier", { pin: "7391" });
    const device = await pairNewDevice(shop);
    for (let i = 0; i < 4; i++) expect(await signIn(device.deviceToken, cashier, "0000")).toEqual({ ok: false, reason: "wrong_pin" });
    expect(await signIn(device.deviceToken, cashier, "0000")).toEqual({ ok: false, reason: "wrong_pin" });
    const state = await counters("staff", cashier);
    expect(state.count).toBe(0);
    const minutes = ((state.locked?.getTime() ?? 0) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);

    expect(await signIn(device.deviceToken, cashier, "4829")).toEqual({ ok: false, reason: "locked" });
    // five failures in a row also lock the till itself (see the next test), so someone else on it waits too...
    expect(await signIn(device.deviceToken, other, "7391")).toEqual({ ok: false, reason: "locked" });
    // ...but not on another till: the person's lock does not spread to other people
    const second = await pairNewDevice(shop, "Counter 2");
    expect(await signIn(second.deviceToken, other, "7391")).toMatchObject({ ok: true });
    expect(await signIn(second.deviceToken, cashier, "4829")).toEqual({ ok: false, reason: "locked" });
    const events = await admin`select after_data from audit.log where tenant_id = ${shop.tenantId} and event_key = 'pin.staff_locked'`;
    expect(events).toHaveLength(1);
    expect(events[0]?.after_data.staff_id).toBe(cashier);
    expect(JSON.stringify(events[0]?.after_data)).not.toContain("4829");

    // when the locks run out, the right PIN works again
    await admin`update app.staff set pin_locked_until = now() - interval '1 second' where id = ${cashier}`;
    await admin`update app.devices set pin_locked_until = now() - interval '1 second' where id = ${device.deviceId}`;
    expect(await signIn(device.deviceToken, cashier, "4829")).toMatchObject({ ok: true });
  });

  it("five wrong PINs in a row on one device (any people) lock the device", async () => {
    const shop = await makeShop("devlock");
    const people = [await addStaff(shop, "cashier", { pin: "4829" }), await addStaff(shop, "cashier", { pin: "7391" }), await addStaff(shop, "cashier", { pin: "5062" })];
    const device = await pairNewDevice(shop);
    const order = [0, 1, 2, 0, 1];
    for (const i of order) expect(await signIn(device.deviceToken, people[i] as string, "0000")).toEqual({ ok: false, reason: "wrong_pin" });
    expect((await counters("devices", device.deviceId)).locked).not.toBeNull();
    expect(await signIn(device.deviceToken, people[2] as string, "5062")).toEqual({ ok: false, reason: "locked" });
    const info = await db.device((tx) => getDeviceInfo(tx, { deviceToken: device.deviceToken, devicePepper: PEPPERS.devicePepper }));
    expect(info?.lockedUntil).toBeInstanceOf(Date);
    expect((await admin`select 1 from audit.log where tenant_id = ${shop.tenantId} and event_key = 'pin.device_locked'`).length).toBe(1);
    await admin`update app.devices set pin_locked_until = now() - interval '1 second' where id = ${device.deviceId}`;
    expect(await signIn(device.deviceToken, people[2] as string, "5062")).toMatchObject({ ok: true });
  });

  it("many guesses started at once still only get five tries (the count is taken up front)", async () => {
    const shop = await makeShop("race");
    const cashier = await addStaff(shop, "cashier", { pin: "4829" });
    const device = await pairNewDevice(shop);
    const results = await Promise.all(Array.from({ length: 24 }, (_, i) => signIn(device.deviceToken, cashier, String(1000 + i))));
    const checked = results.filter((r) => !r.ok && r.reason === "wrong_pin").length;
    const locked = results.filter((r) => !r.ok && r.reason === "locked").length;
    expect(checked).toBe(5);
    expect(locked).toBe(19);
    // and the right PIN, sent during the lock, is refused too
    expect(await signIn(device.deviceToken, cashier, "4829")).toEqual({ ok: false, reason: "locked" });
  });

  it("a person who cannot sign in is 'cannot_sign_in': no PIN, suspended, or not allowed in this branch", async () => {
    const shop = await makeShop("cannot");
    const device = await pairNewDevice(shop);
    const noPin = await addStaff(shop, "cashier");
    const suspended = await addStaff(shop, "cashier", { pin: "4829" });
    await admin`update app.staff set status = 'suspended' where id = ${suspended}`;
    const elsewhere = await addStaff(shop, "cashier", { pin: "7391", branchIds: [newId()] });
    for (const id of [noPin, suspended, elsewhere, newId()]) {
      expect(await signIn(device.deviceToken, id, "4829")).toEqual({ ok: false, reason: "cannot_sign_in" });
    }
    const listed = (await db.device((tx) => listDeviceStaff(tx, { deviceToken: device.deviceToken, devicePepper: PEPPERS.devicePepper }))).map((s) => s.staffId);
    expect(listed).not.toContain(noPin);
    expect(listed).not.toContain(suspended);
    expect(listed).not.toContain(elsewhere);
  });

  it("the till's staff list shows only people who can sign in there, and who is locked", async () => {
    const shop = await makeShop("list");
    const a = await addStaff(shop, "cashier", { pin: "4829" });
    const b = await addStaff(shop, "manager", { pin: "7391", branchIds: [shop.branchId] });
    const device = await pairNewDevice(shop);
    await admin`update app.staff set pin_locked_until = now() + interval '5 minutes' where id = ${b}`;
    const list = await db.device((tx) => listDeviceStaff(tx, { deviceToken: device.deviceToken, devicePepper: PEPPERS.devicePepper }));
    expect(list.map((s) => s.staffId).sort()).toEqual([a, b].sort());
    expect(list.find((s) => s.staffId === b)?.locked).toBe(true);
    expect(list.find((s) => s.staffId === a)?.locked).toBe(false);
  });

  it("works only on a paired device: junk, unknown and other shops' tokens are refused", async () => {
    const shop = await makeShop("only");
    const other = await makeShop("only-other");
    const cashier = await addStaff(shop, "cashier", { pin: "4829" });
    const otherDevice = await pairNewDevice(other);
    expect(await signIn("x".repeat(43), cashier, "4829")).toEqual({ ok: false, reason: "no_device" });
    expect(await signIn("short", cashier, "4829")).toEqual({ ok: false, reason: "no_device" });
    // another shop's device can never sign in this shop's person
    expect(await signIn(otherDevice.deviceToken, cashier, "4829")).toEqual({ ok: false, reason: "cannot_sign_in" });
    expect(await db.device((tx) => getDeviceInfo(tx, { deviceToken: "x".repeat(43), devicePepper: PEPPERS.devicePepper }))).toBeNull();
    expect(await db.device((tx) => listDeviceStaff(tx, { deviceToken: "x".repeat(43), devicePepper: PEPPERS.devicePepper }))).toEqual([]);
  });

  it("a different pepper means a different device: the token is useless without the server's secret", async () => {
    const shop = await makeShop("pepper");
    const cashier = await addStaff(shop, "cashier", { pin: "4829" });
    const device = await pairNewDevice(shop);
    const r = await db.device((tx) => pinSignIn(tx, { deviceToken: device.deviceToken, staffId: cashier, pin: "4829", peppers: { ...PEPPERS, devicePepper: "A".repeat(32) } }));
    expect(r).toEqual({ ok: false, reason: "no_device" });
    const wrongPinPepper = await db.device((tx) => pinSignIn(tx, { deviceToken: device.deviceToken, staffId: cashier, pin: "4829", peppers: { ...PEPPERS, pinPepper: "B".repeat(32) } }));
    expect(wrongPinPepper).toEqual({ ok: false, reason: "wrong_pin" });
  });

  it("a closed shop's tills stop working", async () => {
    const shop = await makeShop("closed");
    const cashier = await addStaff(shop, "cashier", { pin: "4829" });
    const device = await pairNewDevice(shop);
    await admin`update platform.tenants set status = 'closed' where id = ${shop.tenantId}`;
    expect(await signIn(device.deviceToken, cashier, "4829")).toEqual({ ok: false, reason: "no_device" });
  });
});

describe("revoking a device", () => {
  it("ends its sessions at once, refuses its next request, and blocks new sign-ins", async () => {
    const shop = await makeShop("revoke");
    const cashier = await addStaff(shop, "cashier", { pin: "4829" });
    const keep = await pairNewDevice(shop, "Counter 2");
    const device = await pairNewDevice(shop, "Counter 1");
    const ctx = await tillSession(shop, device, cashier, "4829");
    const onOther = await tillSession(shop, keep, cashier, "4829");
    await db.rls(ctx, (tx) => tx.execute(sql`select 1`));

    expect(await db.rls(shop.owner, (tx) => revokeDevice(tx, device.deviceId), { write: true })).toBe(true);
    await expect(db.rls(ctx, (tx) => tx.execute(sql`select 1`))).rejects.toBeInstanceOf(SessionEndedError);
    const [s] = await admin`select ended_reason from app.staff_sessions where id = ${ctx.sessionId ?? ""}`;
    expect(s?.ended_reason).toBe("device_revoked");
    await db.rls(onOther, (tx) => tx.execute(sql`select 1`)); // the other till is untouched

    expect(await signIn(device.deviceToken, cashier, "4829")).toEqual({ ok: false, reason: "no_device" });
    expect(await db.device((tx) => getDeviceInfo(tx, { deviceToken: device.deviceToken, devicePepper: PEPPERS.devicePepper }))).toBeNull();
    expect(await db.rls(shop.owner, (tx) => revokeDevice(tx, device.deviceId), { write: true })).toBe(false);
  });

  it("a session whose device was revoked behind the trigger's back is still refused (the request check looks too)", async () => {
    const shop = await makeShop("revoke2");
    const cashier = await addStaff(shop, "cashier", { pin: "4829" });
    const device = await pairNewDevice(shop);
    const ctx = await tillSession(shop, device, cashier, "4829");
    await admin.begin(async (tx) => {
      await tx`alter table app.devices disable trigger end_sessions_on_revoke`;
      await tx`update app.devices set revoked_at = now(), revoked_by = ${shop.ownerId} where id = ${device.deviceId}`;
      await tx`alter table app.devices enable trigger end_sessions_on_revoke`;
    });
    await expect(db.rls(ctx, (tx) => tx.execute(sql`select 1`))).rejects.toBeInstanceOf(SessionEndedError);
  });

  it("only an owner or manager can revoke", async () => {
    const shop = await makeShop("revoke3");
    const cashier = await addStaff(shop, "cashier", { pin: "4829" });
    const device = await pairNewDevice(shop);
    const ctx = await tillSession(shop, device, cashier, "4829");
    await expectPgError(db.rls(ctx, (tx) => revokeDevice(tx, device.deviceId), { write: true }), PG.permissionDenied);
  });

  it("a revoked device stays revoked and a token can never change (database guard)", async () => {
    const shop = await makeShop("guard");
    const device = await pairNewDevice(shop);
    await db.rls(shop.owner, (tx) => revokeDevice(tx, device.deviceId), { write: true });
    await expectPgError(admin`update app.devices set revoked_at = null, revoked_by = null where id = ${device.deviceId}`.then(() => undefined), PG.checkViolation);
    const fresh = await pairNewDevice(shop);
    await expectPgError(admin`update app.devices set token_hash = ${"f".repeat(64)} where id = ${fresh.deviceId}`.then(() => undefined), PG.checkViolation);
    // the shop's own session cannot do it either
    await expectPgError(db.rls(shop.owner, (tx) => tx.execute(sql`update app.devices set token_hash = ${"e".repeat(64)} where id = ${fresh.deviceId}`), { write: true }), PG.checkViolation);
  });
});

describe("unlocking a till", () => {
  it("an owner or manager opens a locked till early; a cashier cannot; the lock clears for everyone", async () => {
    const shop = await makeShop("unlock");
    const cashier = await addStaff(shop, "cashier", { pin: "4829" });
    const other = await addStaff(shop, "cashier", { pin: "7391" });
    const device = await pairNewDevice(shop);
    for (let i = 0; i < 5; i++) await signIn(device.deviceToken, cashier, "0000");
    expect(await signIn(device.deviceToken, other, "7391")).toEqual({ ok: false, reason: "locked" });
    const second = await pairNewDevice(shop, "Counter 2");
    const session = await tillSession(shop, second, other, "7391");
    await expectPgError(db.rls(session, (tx) => unlockDevice(tx, device.deviceId), { write: true }), PG.permissionDenied);
    expect(await db.rls(shop.owner, (tx) => unlockDevice(tx, device.deviceId), { write: true })).toBe(true);
    expect(await counters("devices", device.deviceId)).toMatchObject({ count: 0, locked: null });
    expect(await signIn(device.deviceToken, other, "7391")).toMatchObject({ ok: true });
    // the person's own lock stays until their PIN is reset
    expect(await signIn(device.deviceToken, cashier, "4829")).toEqual({ ok: false, reason: "locked" });
    expect(await db.rls(shop.owner, (tx) => unlockDevice(tx, newId()), { write: true })).toBe(false);
  });
});

describe("setting a PIN", () => {
  it("refuses weak PINs and stores only a salted, peppered hash", async () => {
    const shop = await makeShop("setpin");
    const cashier = await addStaff(shop, "cashier");
    await expect(setPin(shop, cashier, "1234")).rejects.toBeInstanceOf(PinTooWeakError);
    await expect(setPin(shop, cashier, "00")).rejects.toMatchObject({ problem: "too_short" });
    await setPin(shop, cashier, "4829");
    const [row] = await admin`select pin_hash, pin_set_at from app.staff where id = ${cashier}`;
    expect(row?.pin_hash).toMatch(/^pbkdf2-sha256\$1000\$/);
    expect(row?.pin_hash).not.toContain("4829");
    expect(row?.pin_set_at).toBeInstanceOf(Date);
    const entries = await admin`select after_data from audit.log where tenant_id = ${shop.tenantId} and row_id = ${cashier} and event_key = 'row.update'`;
    expect(JSON.stringify(entries)).not.toContain("pbkdf2");
  });

  it("the database refuses anything that is not a PIN hash", async () => {
    const shop = await makeShop("setpin2");
    for (const bad of ["4829", "plain", "pbkdf2-sha256$x$y$z", "bcrypt$10$abc$def"]) {
      await expectPgError(db.rls(shop.owner, (tx) => tx.execute(sql`select app.set_staff_pin(${shop.ownerId}::uuid, ${bad})`), { write: true }), PG.checkViolation);
    }
  });

  it("anyone can set their own; a manager sets a cashier's but not the owner's; a cashier sets nobody else's", async () => {
    const shop = await makeShop("setpin3");
    const manager = await addStaff(shop, "manager", { pin: "4829" });
    const cashier = await addStaff(shop, "cashier", { pin: "7391" });
    const other = await addStaff(shop, "cashier");
    const device = await pairNewDevice(shop);
    const managerCtx = await tillSession(shop, device, manager, "4829");
    const cashierCtx = await tillSession(shop, device, cashier, "7391");
    const set = (ctx: RlsContext, staffId: string, pin: string) => db.rls(ctx, (tx) => setStaffPin(tx, { staffId, pin, pinPepper: PEPPERS.pinPepper, iterations: FAST }), { write: true });

    await set(cashierCtx, cashier, "2580"); // own
    await set(managerCtx, other, "3947"); // a manager, for a cashier
    await expectPgError(set(managerCtx, shop.ownerId, "6140"), PG.permissionDenied); // not the owner's
    await expectPgError(set(cashierCtx, other, "6140"), PG.permissionDenied);
    await set(shop.owner, manager, "9185"); // the owner may set a manager's
    await set(shop.owner, shop.ownerId, "6140"); // and their own
    expect(await signIn(device.deviceToken, cashier, "2580")).toMatchObject({ ok: true });
  });

  it("a new PIN clears a lock (the way to recover from one)", async () => {
    const shop = await makeShop("setpin4");
    const cashier = await addStaff(shop, "cashier", { pin: "4829" });
    await admin`update app.staff set pin_locked_until = now() + interval '10 minutes', pin_failed_count = 3 where id = ${cashier}`;
    await setPin(shop, cashier, "7391");
    expect(await counters("staff", cashier)).toMatchObject({ count: 0, locked: null });
  });
});

describe("one-time PIN approval (step-up)", () => {
  async function scene(prefix: string) {
    const shop = await makeShop(prefix);
    const manager = await addStaff(shop, "manager", { pin: "4829" });
    const cashier = await addStaff(shop, "cashier", { pin: "7391" });
    const device = await pairNewDevice(shop);
    const cashierCtx = await tillSession(shop, device, cashier, "7391");
    return { shop, manager, cashier, device, cashierCtx };
  }
  const ask = (ctx: RlsContext, approverId: string, pin: string, actionKey = "sale:below_floor", entityId?: string) =>
    db.rls(ctx, (tx) => requestStepUp(tx, { approverId, pin, actionKey, ...(entityId ? { entityId } : {}), pinPepper: PEPPERS.pinPepper }), { write: true });
  const spend = (ctx: RlsContext, verificationId: string, actionKey = "sale:below_floor", entityId?: string) =>
    db.rls(ctx, (tx) => consumeStepUp(tx, { verificationId, actionKey, ...(entityId ? { entityId } : {}) }), { write: true });

  it("a manager types their PIN on the cashier's till; the action spends the approval once", async () => {
    const { manager, cashierCtx } = await scene("step");
    const approval = await ask(cashierCtx, manager, "4829");
    expect(approval.ok).toBe(true);
    if (!approval.ok) return;
    const seconds = (approval.expiresAt.getTime() - Date.now()) / 1000;
    expect(seconds).toBeGreaterThan(110);
    expect(seconds).toBeLessThanOrEqual(120);
    expect(await spend(cashierCtx, approval.verificationId)).toEqual({ approverId: manager });
    await expect(spend(cashierCtx, approval.verificationId)).rejects.toBeInstanceOf(StepUpInvalidError);
  });

  it("is bound to one action: another action cannot spend it, and a failed try does not use it up", async () => {
    const { manager, cashierCtx } = await scene("step2");
    const approval = await ask(cashierCtx, manager, "4829", "sale:below_floor");
    if (!approval.ok) throw new Error("expected approval");
    await expect(spend(cashierCtx, approval.verificationId, "refund:create")).rejects.toBeInstanceOf(StepUpInvalidError);
    await expect(spend(cashierCtx, approval.verificationId, "sale:below_floor_x")).rejects.toBeInstanceOf(StepUpInvalidError);
    expect(await spend(cashierCtx, approval.verificationId, "sale:below_floor")).toEqual({ approverId: manager });
  });

  it("when bound to a record, only that record can spend it; unbound works for any", async () => {
    const { manager, cashierCtx } = await scene("step3");
    const record = newId();
    const bound = await ask(cashierCtx, manager, "4829", "refund:create", record);
    if (!bound.ok) throw new Error("expected approval");
    await expect(spend(cashierCtx, bound.verificationId, "refund:create", newId())).rejects.toBeInstanceOf(StepUpInvalidError);
    await expect(spend(cashierCtx, bound.verificationId, "refund:create")).rejects.toBeInstanceOf(StepUpInvalidError);
    expect(await spend(cashierCtx, bound.verificationId, "refund:create", record)).toEqual({ approverId: manager });

    const loose = await ask(cashierCtx, manager, "4829", "refund:create");
    if (!loose.ok) throw new Error("expected approval");
    expect(await spend(cashierCtx, loose.verificationId, "refund:create", newId())).toEqual({ approverId: manager });
  });

  it("only the session that asked can spend it (another cashier, or the manager, cannot)", async () => {
    const { shop, manager, cashier, device, cashierCtx } = await scene("step4");
    const second = await addStaff(shop, "cashier", { pin: "5062" });
    const secondCtx = await tillSession(shop, device, second, "5062");
    const approval = await ask(cashierCtx, manager, "4829");
    if (!approval.ok) throw new Error("expected approval");
    await expect(spend(secondCtx, approval.verificationId)).rejects.toBeInstanceOf(StepUpInvalidError);
    await expect(spend(shop.owner, approval.verificationId)).rejects.toBeInstanceOf(StepUpInvalidError);
    // the same cashier signing in again (a new session) cannot use it either only if on another device; same device: allowed
    expect(await spend(cashierCtx, approval.verificationId)).toEqual({ approverId: manager });
    expect(cashier).toBeDefined();
  });

  it("an approval of another shop, a made-up id, or an expired one is refused", async () => {
    const { shop, manager, cashierCtx } = await scene("step5");
    const other = await scene("step5-other");
    const theirs = await ask(other.cashierCtx, other.manager, "4829");
    if (!theirs.ok) throw new Error("expected approval");
    await expect(spend(cashierCtx, theirs.verificationId)).rejects.toBeInstanceOf(StepUpInvalidError);
    await expect(spend(cashierCtx, newId())).rejects.toBeInstanceOf(StepUpInvalidError);

    const mine = await ask(cashierCtx, manager, "4829");
    if (!mine.ok) throw new Error("expected approval");
    await admin.begin(async (tx) => {
      await tx`alter table app.pin_verifications disable trigger guard_pin_verification_update`;
      await tx`update app.pin_verifications set verified_at = now() - interval '3 minutes', expires_at = now() - interval '1 minute' where id = ${mine.verificationId}`;
      await tx`alter table app.pin_verifications enable trigger guard_pin_verification_update`;
    });
    await expect(spend(cashierCtx, mine.verificationId)).rejects.toBeInstanceOf(StepUpInvalidError);
    expect(shop.tenantId).toBeDefined();
  });

  it("is void if the approver is suspended before it is spent", async () => {
    const { manager, cashierCtx } = await scene("step6");
    const approval = await ask(cashierCtx, manager, "4829");
    if (!approval.ok) throw new Error("expected approval");
    await admin`update app.staff set status = 'suspended' where id = ${manager}`;
    await expect(spend(cashierCtx, approval.verificationId)).rejects.toBeInstanceOf(StepUpInvalidError);
  });

  it("a wrong approver PIN is counted and locks after five; unknown or PIN-less approvers cannot approve", async () => {
    const { shop, manager, cashierCtx } = await scene("step7");
    expect(await ask(cashierCtx, manager, "0000")).toEqual({ ok: false, reason: "wrong_pin" });
    expect(await counters("staff", manager)).toMatchObject({ count: 1 });
    for (let i = 0; i < 4; i++) await ask(cashierCtx, manager, "0000");
    expect(await ask(cashierCtx, manager, "4829")).toEqual({ ok: false, reason: "locked" });
    const noPin = await addStaff(shop, "manager");
    expect(await ask(cashierCtx, noPin, "4829")).toEqual({ ok: false, reason: "cannot_approve" });
    expect(await ask(cashierCtx, newId(), "4829")).toEqual({ ok: false, reason: "cannot_approve" });
  });

  it("the audit log records whose PIN approved the action", async () => {
    const { shop, manager, cashierCtx } = await scene("step8");
    const approval = await ask(cashierCtx, manager, "4829", "product:edit_price");
    if (!approval.ok) throw new Error("expected approval");
    await db.rls(
      cashierCtx,
      async (tx) => {
        await consumeStepUp(tx, { verificationId: approval.verificationId, actionKey: "product:edit_price" });
        await tx.execute(sql`update app.branches set phone = '0911000000' where is_default`);
      },
      { write: true },
    );
    const entries = await admin`
      select pin_verification_id, actor_id from audit.log
      where tenant_id = ${shop.tenantId} and table_name = 'app.branches' and event_key = 'row.update' order by seq desc limit 1`;
    expect(entries[0]?.pin_verification_id).toBe(approval.verificationId);
    expect(entries[0]?.actor_id).toBe(cashierCtx.staffId);
    // an ordinary write afterwards is NOT marked as approved
    await db.rls(cashierCtx, (tx) => tx.execute(sql`update app.branches set phone = '0911000001' where is_default`), { write: true });
    const [later] = await admin`select pin_verification_id from audit.log where tenant_id = ${shop.tenantId} and table_name = 'app.branches' and event_key = 'row.update' order by seq desc limit 1`;
    expect(later?.pin_verification_id).toBeNull();
  });

  it("an approval can only be used up, once; nothing else about it can be changed (database guard)", async () => {
    const { manager, cashierCtx } = await scene("step9");
    const approval = await ask(cashierCtx, manager, "4829");
    if (!approval.ok) throw new Error("expected approval");
    const id = approval.verificationId;
    await expectPgError(admin`update app.pin_verifications set action_key = 'refund:approve' where id = ${id}`.then(() => undefined), PG.checkViolation);
    await expectPgError(admin`update app.pin_verifications set expires_at = now() + interval '1 day' where id = ${id}`.then(() => undefined), PG.checkViolation);
    await expectPgError(admin`update app.pin_verifications set consumed_at = null where id = ${id}`.then(() => undefined), PG.checkViolation);
    await spend(cashierCtx, id);
    await expectPgError(admin`update app.pin_verifications set consumed_at = null where id = ${id}`.then(() => undefined), PG.checkViolation);
    await expectPgError(admin`update app.pin_verifications set consumed_at = now() where id = ${id}`.then(() => undefined), PG.checkViolation);
  });

  it("an action key that is not a permission cannot be approved by anyone, and costs the approver nothing", async () => {
    const { manager, cashierCtx } = await scene("step10");
    for (const bad of ["", "refund", "Refund:Approve", "refund:", ":approve", "refund approve", "nothing:real"]) {
      expect(await ask(cashierCtx, manager, "4829", bad), bad).toEqual({ ok: false, reason: "cannot_approve" });
    }
    expect(await counters("staff", manager)).toMatchObject({ count: 0 });
  });

  it("only someone who holds the action's permission can approve it (a cashier cannot approve a refund)", async () => {
    const { shop, manager, cashierCtx } = await scene("step11");
    const otherCashier = await addStaff(shop, "cashier", { pin: "5062" });
    expect(await ask(cashierCtx, otherCashier, "5062", "refund:create")).toEqual({ ok: false, reason: "cannot_approve" });
    expect(await counters("staff", otherCashier)).toMatchObject({ count: 0 });
    expect((await ask(cashierCtx, manager, "4829", "refund:create")).ok).toBe(true);
    // a personal deny takes it away from the manager
    await db.rls(shop.owner, (tx) => setOverride(tx, { staffId: manager, key: "refund:create", effect: "deny", reason: "test" }), { write: true });
    expect(await ask(cashierCtx, manager, "4829", "refund:create")).toEqual({ ok: false, reason: "cannot_approve" });
    // and the owner (who holds everything) can approve
    const owner = await addStaff(shop, "owner", { pin: "9185" });
    expect((await ask(cashierCtx, owner, "9185", "refund:create")).ok).toBe(true);
  });
});

describe("rules shared with core", () => {
  it("the SQL lockout step equals core's afterPinFailure for every state we can think of", async () => {
    const now = new Date("2026-10-16T10:00:00.000Z");
    const locks = [null, new Date(now.getTime() - 60_000), new Date(now.getTime()), new Date(now.getTime() + 60_000)];
    for (let count = 0; count <= 5; count++) {
      for (const locked of locks) {
        const expected = afterPinFailure({ failedCount: count, lockedUntil: locked }, now);
        const [row] = await admin`select new_count, new_locked from private.pin_failure_step(${count}::int, ${locked ? locked.toISOString() : null}::timestamptz, ${now.toISOString()}::timestamptz)`;
        expect({ count: row?.new_count, locked: (row?.new_locked as Date | null)?.getTime() ?? null }, `count ${count}, lock ${locked?.toISOString()}`).toEqual({
          count: expected.failedCount,
          locked: expected.lockedUntil?.getTime() ?? null,
        });
      }
    }
  });

  it("the rate limiter counts within a window and starts over after it", async () => {
    const key = `test:${suffix()}`;
    const hit = async (max: number, window: number) => (await admin`select private.hit_rate_limit(${key}, ${max}::int, ${window}::int) as ok`)[0]?.ok;
    expect([await hit(3, 600), await hit(3, 600), await hit(3, 600), await hit(3, 600), await hit(3, 600)]).toEqual([true, true, true, false, false]);
    await admin`update private.rate_limits set window_start = now() - interval '11 minutes' where key = ${key}`;
    expect(await hit(3, 600)).toBe(true);
    expect(await hit(1, 600)).toBe(false);
  });
});

describe("what a shop's own session can and cannot reach", () => {
  it("cannot read the rate limit counters, and sees only its own devices and codes", async () => {
    const a = await makeShop("reacha");
    const b = await makeShop("reachb");
    await pairNewDevice(a);
    await pairNewDevice(b);
    await expectPgError(db.rls(a.owner, (tx) => tx.execute(sql`select * from private.rate_limits`)), PG.permissionDenied);
    const rows = await db.rls(a.owner, (tx) => tx.execute(sql`select tenant_id from app.devices`));
    expect(rows.length).toBe(1);
    expect(rows.every((r) => r.tenant_id === a.tenantId)).toBe(true);
    const hashed = await hashPin("4829", PEPPERS.pinPepper, { iterations: 1 });
    expect(hashed).toContain("pbkdf2-sha256$1$");
  });

  it("the device-side functions give nothing without a secret: no code, no token, no PIN, no data", async () => {
    const shop = await makeShop("nodata");
    await pairNewDevice(shop);
    const direct = await db.device((tx) => tx.execute(sql`select count(*)::int as n from app.devices`));
    expect(direct[0]?.n).toBe(0); // no shop context: the table shows nothing
    const none = await db.device((tx) => tx.execute(sql`select * from app.device_info('nonsense')`));
    expect(none.length).toBe(0);
    const staff = await db.device((tx) => tx.execute(sql`select * from app.device_staff('nonsense')`));
    expect(staff.length).toBe(0);
  });
});

describe("each function defends itself (not only the one that normally calls it)", () => {
  const tokenHash = (token: string) => hmacHex(PEPPERS.devicePepper, `device-token:${token}`);

  it("pairing is capped across the whole platform, whatever address the guesses come from", async () => {
    await admin`insert into private.rate_limits (key, window_start, hits) values ('pair:all', now(), 300)
                on conflict (key) do update set window_start = now(), hits = 300`;
    try {
      const result = await db.device((tx) => pairDevice(tx, { code: generatePairingCode(), name: "T", kind: "pos", rateKey: `rk-${suffix()}`, devicePepper: PEPPERS.devicePepper }));
      expect(result).toEqual({ ok: false, reason: "rate_limited" });
    } finally {
      await admin`delete from private.rate_limits where key = 'pair:all'`;
    }
  });

  it("an approval cannot be spent from the same person's session on a different till", async () => {
    const shop = await makeShop("bind");
    const manager = await addStaff(shop, "manager", { pin: "4829" });
    const cashier = await addStaff(shop, "cashier", { pin: "7391" });
    const one = await pairNewDevice(shop, "Counter 1");
    const two = await pairNewDevice(shop, "Counter 2");
    const onOne = await tillSession(shop, one, cashier, "7391");
    const onTwo = await tillSession(shop, two, cashier, "7391");
    const approval = await db.rls(onOne, (tx) => requestStepUp(tx, { approverId: manager, pin: "4829", actionKey: "sale:below_floor", pinPepper: PEPPERS.pinPepper }), { write: true });
    if (!approval.ok) throw new Error("expected approval");
    await expect(db.rls(onTwo, (tx) => consumeStepUp(tx, { verificationId: approval.verificationId, actionKey: "sale:below_floor" }), { write: true })).rejects.toBeInstanceOf(StepUpInvalidError);
    expect(await db.rls(onOne, (tx) => consumeStepUp(tx, { verificationId: approval.verificationId, actionKey: "sale:below_floor" }), { write: true })).toEqual({ approverId: manager });
  });

  it("an approval cannot be changed while being marked used", async () => {
    const shop = await makeShop("edit");
    const manager = await addStaff(shop, "manager", { pin: "4829" });
    const cashier = await addStaff(shop, "cashier", { pin: "7391" });
    const device = await pairNewDevice(shop);
    const ctx = await tillSession(shop, device, cashier, "7391");
    const approval = await db.rls(ctx, (tx) => requestStepUp(tx, { approverId: manager, pin: "4829", actionKey: "sale:below_floor", pinPepper: PEPPERS.pinPepper }), { write: true });
    if (!approval.ok) throw new Error("expected approval");
    const id = approval.verificationId;
    await expectPgError(admin`update app.pin_verifications set consumed_at = now(), action_key = 'refund:approve' where id = ${id}`.then(() => undefined), PG.checkViolation);
    await expectPgError(admin`update app.pin_verifications set consumed_at = now(), expires_at = now() + interval '1 day' where id = ${id}`.then(() => undefined), PG.checkViolation);
    await expectPgError(admin`update app.pin_verifications set consumed_at = now(), staff_id = ${cashier} where id = ${id}`.then(() => undefined), PG.checkViolation);
  });

  it("finishing a PIN sign-in re-checks everything itself: expiry, person, device", async () => {
    const shop = await makeShop("finish");
    const cashier = await addStaff(shop, "cashier", { pin: "4829" });
    const device = await pairNewDevice(shop);
    const hash = await tokenHash(device.deviceToken);
    const finish = (staffId: string, expires: string, token = hash) =>
      db.device((tx) => tx.execute(sql`select * from app.pin_sign_in_finish(${token}, ${staffId}::uuid, ${newId()}::uuid, ${expires}::timestamptz)`));
    const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

    await expectPgError(finish(cashier, hours(48)), PG.checkViolation);
    await expectPgError(finish(cashier, hours(-1)), PG.checkViolation);
    await expect(finish(newId(), hours(12))).rejects.toBeInstanceOf(SessionEndedError);
    const suspended = await addStaff(shop, "cashier", { pin: "7391" });
    await admin`update app.staff set status = 'suspended' where id = ${suspended}`;
    await expect(finish(suspended, hours(12))).rejects.toBeInstanceOf(SessionEndedError);
    await expect(finish(cashier, hours(12), "f".repeat(64))).rejects.toBeInstanceOf(SessionEndedError);

    await db.rls(shop.owner, (tx) => revokeDevice(tx, device.deviceId), { write: true });
    await expect(finish(cashier, hours(12))).rejects.toBeInstanceOf(SessionEndedError);
  });

  it("an attempt against a revoked device is refused by the counting function itself", async () => {
    const shop = await makeShop("attempt");
    const cashier = await addStaff(shop, "cashier", { pin: "4829" });
    const device = await pairNewDevice(shop);
    await db.rls(shop.owner, (tx) => revokeDevice(tx, device.deviceId), { write: true });
    const [row] = await admin`select o_status from private.pin_attempt(${shop.tenantId}::uuid, ${device.deviceId}::uuid, ${cashier}::uuid)`;
    expect(row?.o_status).toBe("no_device");
  });

  it("an approval cannot be recorded for someone with no PIN", async () => {
    const shop = await makeShop("nopin");
    const cashier = await addStaff(shop, "cashier", { pin: "7391" });
    const noPin = await addStaff(shop, "manager");
    const device = await pairNewDevice(shop);
    const ctx = await tillSession(shop, device, cashier, "7391");
    await expect(
      db.rls(ctx, (tx) => tx.execute(sql`select app.step_up_finish(${newId()}::uuid, ${noPin}::uuid, 'sale:below_floor', null)`), { write: true }),
    ).rejects.toSatisfy((e: unknown) => (e as { cause?: { code?: string }; code?: string }).cause?.code === "RT007" || (e as { code?: string }).code === "RT007");
  });
});
