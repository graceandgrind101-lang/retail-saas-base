import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { SETTING_KEYS, signSessionCookie } from "@retail/core";
import { createTenantDb, setStaffPin, type TenantDb } from "@retail/db";
import { createAdminDb, provisionTenant, type AdminDb } from "@retail/db/admin";
import { createDeviceHandlers } from "../lib/devices/handlers";
import { createSettingsHandlers } from "../lib/settings/handlers";
import { newUuid } from "./ids";

const APP_URL = "http://localhost:3000";
const SESSION_SECRET = "k3Jf9aQ2xLm7ZpR1tVb8nWc4yHd6sGu0";
const PEPPERS = { devicePepper: "Zx6cVb3nMq8wEr1tYu4iOp7aSd2fGh5j", pinPepper: "Qw8eRt5yUi2oPa7sDf4gHj1kLz9xCv3b" };

let admin: AdminDb;
let db: TenantDb;
let settings: ReturnType<typeof createSettingsHandlers>;
let devices: ReturnType<typeof createDeviceHandlers>;

beforeAll(() => {
  admin = createAdminDb(inject("adminUrl"), { max: 3 });
  db = createTenantDb(inject("appUrl"), { max: 6 });
  settings = createSettingsHandlers({ db, sessionSecret: SESSION_SECRET, appUrl: APP_URL });
  devices = createDeviceHandlers({ db, peppers: PEPPERS, sessionSecret: SESSION_SECRET, appUrl: APP_URL });
});
afterAll(async () => {
  await db.close();
  await admin.close();
});

const suffix = () => randomBytes(4).toString("hex");

function request(method: "GET" | "POST", path: string, options: { body?: unknown; origin?: string | null; cookie?: string } = {}): Request {
  const headers = new Headers();
  const origin = options.origin === undefined ? APP_URL : options.origin;
  if (origin !== null) headers.set("origin", origin);
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`${APP_URL}${path}`, { method, headers, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
}
interface Json {
  error?: string;
  saved?: boolean;
  settings?: { key: string; value: unknown; state: string; sensitive: boolean; customised: boolean }[];
  verificationId?: string;
}
const json = async (response: Response): Promise<Json> => (await response.json()) as Json;

async function shop(prefix: string) {
  const created = await provisionTenant(admin.sql, { slug: `${prefix}-${suffix()}`, displayName: { en: `Shop ${prefix}` }, industry: "electronics", planKey: "pro" });
  const roleIds = created.roleIds as Record<string, string>;
  async function person(roleKey: "owner" | "manager" | "cashier", pin?: string) {
    const staffId = newUuid();
    const sessionId = newUuid();
    await admin.sql`insert into app.staff (id, tenant_id, display_name, role_id, status) values (${staffId}, ${created.tenantId}, ${`${roleKey} ${suffix()}`}, ${roleIds[roleKey] as string}, 'active')`;
    await admin.sql`insert into app.staff_sessions (id, tenant_id, staff_id, method, expires_at) values (${sessionId}, ${created.tenantId}, ${staffId}, 'password', now() + interval '1 day')`;
    const value = await signSessionCookie({ tenantId: created.tenantId, staffId, sessionId, expiresAt: Math.floor(Date.now() / 1000) + 3600 }, SESSION_SECRET);
    const cookie = `retail_session=${value}`;
    if (pin) await db.rls({ tenantId: created.tenantId, staffId, sessionId }, (tx) => setStaffPin(tx, { staffId, pin, pinPepper: PEPPERS.pinPepper, iterations: 1000 }), { write: true });
    return { staffId, cookie };
  }
  return { tenantId: created.tenantId, person };
}

const save = (cookie: string | undefined, body: unknown, extra: { origin?: string | null } = {}) =>
  settings.save(request("POST", "/api/settings", { ...(cookie ? { cookie } : {}), body, ...extra }));
const list = (cookie?: string) => settings.list(request("GET", "/api/settings", cookie ? { cookie } : {}));

describe("GET /api/settings", () => {
  it("lists every setting with its value, state and whether it asks for a PIN", async () => {
    const s = await shop("list");
    const manager = await s.person("manager");
    const response = await list(manager.cookie); // a manager holds settings:view
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await json(response);
    expect(body.settings?.map((x) => x.key)).toEqual(SETTING_KEYS);
    expect(body.settings?.find((x) => x.key === "inventory.low_stock_threshold")).toMatchObject({ value: 5, state: "editable", sensitive: false, customised: false });
    expect(body.settings?.find((x) => x.key === "business.phone")).toMatchObject({ sensitive: true, state: "editable" });
    expect(body.settings?.find((x) => x.key === "payments.cbe_account")).toMatchObject({ state: "locked" });
  });

  it("needs a sign-in and settings:view", async () => {
    const s = await shop("listperm");
    const cashier = await s.person("cashier");
    expect((await list()).status).toBe(401);
    expect((await list("retail_session=junk")).status).toBe(401);
    const denied = await list(cashier.cookie);
    expect(denied.status).toBe(403);
    expect(await json(denied)).toEqual({ error: "forbidden" });
  });
});

describe("POST /api/settings", () => {
  it("an owner saves an ordinary setting; the next listing shows it", async () => {
    const s = await shop("save");
    const owner = await s.person("owner");
    const response = await save(owner.cookie, { key: "inventory.low_stock_threshold", value: 12 });
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ saved: true });
    const after = await json(await list(owner.cookie));
    expect(after.settings?.find((x) => x.key === "inventory.low_stock_threshold")).toMatchObject({ value: 12, customised: true });
  });

  it("only someone with settings:edit: a manager may look but not change", async () => {
    const s = await shop("editperm");
    const manager = await s.person("manager");
    const denied = await save(manager.cookie, { key: "inventory.low_stock_threshold", value: 9 });
    expect(denied.status).toBe(403);
    expect(await json(denied)).toEqual({ error: "forbidden" });
  });

  it("a locked setting is refused for an owner, with the same answer however it is asked", async () => {
    const s = await shop("locked");
    const owner = await s.person("owner", "4829");
    for (const body of [
      { key: "pricing.max_discount_percent", value: 90 },
      { key: "receipt.not_fiscal_label", value: false },
      { key: "security.pos_idle_lock_seconds", value: 0 },
      { key: "payments.telebirr_number", value: "0911000000" },
    ]) {
      const response = await save(owner.cookie, body);
      expect(response.status, JSON.stringify(body)).toBe(403);
      expect(await json(response)).toEqual({ error: "setting_locked" });
    }
    // even with a real PIN approval in hand, a locked setting stays locked and the approval is not spent
    const approval = await json(await devices.stepUp(request("POST", "/api/step-up", { cookie: owner.cookie, body: { approverId: owner.staffId, pin: "4829", actionKey: "settings:edit" } })));
    expect(approval.verificationId).toBeDefined();
    const locked = await save(owner.cookie, { key: "payments.telebirr_number", value: "0911000000", verificationId: approval.verificationId });
    expect(await json(locked)).toEqual({ error: "setting_locked" });
    const rows = await admin.sql`select 1 from app.tenant_settings where tenant_id = ${s.tenantId}`;
    expect(rows).toHaveLength(0);
  });

  it("a sensitive setting needs the owner's own PIN: refused without it, saved with it, and the approval works once", async () => {
    const s = await shop("sensitive");
    const owner = await s.person("owner", "4829");
    const without = await save(owner.cookie, { key: "business.phone", value: "0911000000" });
    expect(without.status).toBe(403);
    expect(await json(without)).toEqual({ error: "pin_required" });

    const wrong = await devices.stepUp(request("POST", "/api/step-up", { cookie: owner.cookie, body: { approverId: owner.staffId, pin: "0000", actionKey: "settings:edit" } }));
    expect(wrong.status).toBe(403);
    expect(await json(wrong)).toEqual({ error: "wrong_pin" });

    const approval = await json(await devices.stepUp(request("POST", "/api/step-up", { cookie: owner.cookie, body: { approverId: owner.staffId, pin: "4829", actionKey: "settings:edit" } })));
    const verificationId = approval.verificationId as string;
    const saved = await save(owner.cookie, { key: "business.phone", value: "0911000000", verificationId });
    expect(await json(saved)).toEqual({ saved: true });
    const again = await save(owner.cookie, { key: "business.phone", value: "0922000000", verificationId });
    expect(again.status).toBe(403);
    expect(await json(again)).toEqual({ error: "approval_invalid" });
    const [row] = await admin.sql`select value from app.tenant_settings where tenant_id = ${s.tenantId} and key = 'business.phone'`;
    expect(row?.value).toBe("0911000000");
  });

  it("an approval from a different person's session does not work", async () => {
    const s = await shop("borrowed");
    const owner = await s.person("owner", "4829");
    const second = await s.person("owner");
    const approval = await json(await devices.stepUp(request("POST", "/api/step-up", { cookie: owner.cookie, body: { approverId: owner.staffId, pin: "4829", actionKey: "settings:edit" } })));
    const response = await save(second.cookie, { key: "business.phone", value: "0911000000", verificationId: approval.verificationId });
    expect(response.status).toBe(403);
    expect(await json(response)).toEqual({ error: "approval_invalid" });
  });

  it("refuses values that do not fit, unknown settings, and a language the app does not offer", async () => {
    const s = await shop("invalid");
    const owner = await s.person("owner");
    for (const body of [
      { key: "inventory.low_stock_threshold", value: -1 },
      { key: "inventory.low_stock_threshold", value: "5" },
      { key: "receipt.show_cashier", value: "yes" },
      { key: "receipt.footer", value: "text" },
      { key: "locale.default_calendar", value: "julian" },
      { key: "locale.default_language", value: "fr" },
      { key: "locale.default_language", value: "xx" },
      { key: "nope.nope", value: 1 },
      { key: "constructor", value: 1 },
    ]) {
      const response = await save(owner.cookie, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await json(response)).toEqual({ error: "invalid_value" });
    }
    expect((await save(owner.cookie, { key: "locale.default_language", value: "am" })).status).toBe(200);
    expect((await save(owner.cookie, { key: "locale.default_calendar", value: "ethiopian" })).status).toBe(200);
    const rows = await admin.sql`select key from app.tenant_settings where tenant_id = ${s.tenantId} order by key`;
    expect(rows.map((r) => r.key)).toEqual(["locale.default_calendar", "locale.default_language"]);
  });

  it("checks the shape of the request, the origin and the session", async () => {
    const s = await shop("shape");
    const owner = await s.person("owner");
    expect((await save(owner.cookie, { key: "inventory.low_stock_threshold", value: 9, extra: 1 })).status).toBe(400);
    expect((await save(owner.cookie, { value: 9 })).status).toBe(400);
    expect((await save(owner.cookie, { key: "inventory.low_stock_threshold", value: 9, verificationId: "nope" })).status).toBe(400);
    expect((await save(owner.cookie, { key: "x".repeat(81), value: 1 })).status).toBe(400);
    expect((await save(owner.cookie, { key: "inventory.low_stock_threshold", value: 9 }, { origin: null })).status).toBe(403);
    expect((await save(owner.cookie, { key: "inventory.low_stock_threshold", value: 9 }, { origin: "http://evil.example" })).status).toBe(403);
    expect((await save(undefined, { key: "inventory.low_stock_threshold", value: 9 })).status).toBe(401);
    const rows = await admin.sql`select 1 from app.tenant_settings where tenant_id = ${s.tenantId}`;
    expect(rows).toHaveLength(0);
  });

  it("a platform policy that locks a setting is honoured by the endpoint", async () => {
    const s = await shop("policy");
    const owner = await s.person("owner");
    await admin.sql`insert into platform.setting_policies (id, tenant_id, key, state) values (${newUuid()}, ${s.tenantId}, 'inventory.low_stock_threshold', 'locked')`;
    const response = await save(owner.cookie, { key: "inventory.low_stock_threshold", value: 9 });
    expect(await json(response)).toEqual({ error: "setting_locked" });
    const listed = await json(await list(owner.cookie));
    expect(listed.settings?.find((x) => x.key === "inventory.low_stock_threshold")?.state).toBe("locked");
  });
});
