import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEV_DEMO_OWNER_ACCOUNT_ID } from "@retail/core";
import { getDeviceInfo, listDeviceStaff, pairDevice, pinSignIn } from "../src/devices";
import { DEMO_PINS, DEMO_SLUG, seedDemoShop } from "../src/dev-seed";
import { createTenantDb, type TenantDb } from "../src/rls";
import { listMyShops, startSession } from "../src/sign-in";
import { adminSql, appUrl } from "./helpers";

const admin: Sql = adminSql(2);
let db: TenantDb;
const PEPPERS = { devicePepper: "Zx6cVb3nMq8wEr1tYu4iOp7aSd2fGh5j", pinPepper: "Qw8eRt5yUi2oPa7sDf4gHj1kLz9xCv3b" };

beforeAll(() => {
  db = createTenantDb(appUrl(), { max: 4 });
});
afterAll(async () => {
  await db.close();
  await admin.end();
});

describe("the demo shop for local development", () => {
  it("creates a shop whose owner can sign in with the demo account, and is safe to run again", async () => {
    const first = await seedDemoShop(admin, PEPPERS);
    expect(first.ownerAccountId).toBe(DEV_DEMO_OWNER_ACCOUNT_ID);
    const again = await seedDemoShop(admin, PEPPERS);
    expect(again.tenantId).toBe(first.tenantId);
    expect(again.created).toBe(false);
    expect(again.pairingCode).not.toBe(first.pairingCode);

    const staff = await admin`select display_name from app.staff where tenant_id = ${first.tenantId} order by display_name`;
    expect(staff.map((s) => s.display_name)).toEqual(["Demo Cashier", "Demo Manager", "Demo Owner"]); // not duplicated by the second run

    const identity = { authUserId: DEV_DEMO_OWNER_ACCOUNT_ID, email: "dev@example.com" };
    const shops = await db.identity(identity, (tx) => listMyShops(tx));
    expect(shops.map((s) => [s.slug, s.roleKey])).toEqual([[DEMO_SLUG, "owner"]]);
    const session = await db.identity(identity, (tx) => startSession(tx, { tenantId: first.tenantId, method: "password" }));
    expect(session.staffId).toBe(shops[0]?.staffId);
  });

  it("the printed code connects a device, and the printed PINs sign people in on it", async () => {
    const seed = await seedDemoShop(admin, PEPPERS);
    const paired = await db.device((tx) => pairDevice(tx, { code: seed.pairingCode, name: "Counter 1", kind: "pos", rateKey: `seed-${Math.random()}`, devicePepper: PEPPERS.devicePepper }));
    expect(paired.ok).toBe(true);
    if (!paired.ok) return;
    const info = await db.device((tx) => getDeviceInfo(tx, { deviceToken: paired.deviceToken, devicePepper: PEPPERS.devicePepper }));
    expect(info?.tenantSlug).toBe(DEMO_SLUG);
    const people = await db.device((tx) => listDeviceStaff(tx, { deviceToken: paired.deviceToken, devicePepper: PEPPERS.devicePepper }));
    expect(people.map((p) => p.displayName)).toEqual(["Demo Cashier", "Demo Manager"]); // the owner has no PIN

    for (const [name, pin] of [["Demo Manager", DEMO_PINS.manager], ["Demo Cashier", DEMO_PINS.cashier]] as const) {
      const person = people.find((p) => p.displayName === name);
      const result = await db.device((tx) => pinSignIn(tx, { deviceToken: paired.deviceToken, staffId: person?.staffId as string, pin, peppers: PEPPERS }));
      expect(result.ok, name).toBe(true);
    }
  });

  it("has two sample alerts for the alerts screen, and no more after a second run", async () => {
    await seedDemoShop(admin, PEPPERS);
    const [shop] = await admin`select id from platform.tenants where slug = ${DEMO_SLUG}`;
    const alerts = await admin`select rule_key, status from app.alerts where tenant_id = ${shop?.id as string} order by rule_key`;
    expect(alerts.map((a) => a.rule_key)).toEqual(["pin.device_locked", "pin.staff_locked"]);
    expect(alerts.every((a) => a.status === "new")).toBe(true);
  });

  it("the pairing code is single-use and a second code works independently", async () => {
    const one = await seedDemoShop(admin, PEPPERS);
    const two = await seedDemoShop(admin, PEPPERS);
    const use = (code: string) => db.device((tx) => pairDevice(tx, { code, name: "T", kind: "phone", rateKey: `seed-${Math.random()}`, devicePepper: PEPPERS.devicePepper }));
    expect((await use(one.pairingCode)).ok).toBe(true);
    expect((await use(one.pairingCode)).ok).toBe(false);
    expect((await use(two.pairingCode)).ok).toBe(true);
  });
});
