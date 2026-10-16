import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { DEV_DEMO_OWNER_ACCOUNT_ID, readSessionCookie } from "@retail/core";
import { createTenantDb, type TenantDb } from "@retail/db";
import { createAdminDb, seedDemoShop, type AdminDb } from "@retail/db/admin";
import { createDevSignIn } from "../lib/auth/dev";
import { DEFAULT_POS_IDLE_SECONDS, posIdleSeconds } from "../lib/shell/idle";

const APP_URL = "http://localhost:3000";
const SESSION_SECRET = "k3Jf9aQ2xLm7ZpR1tVb8nWc4yHd6sGu0";
const PEPPERS = { devicePepper: "Zx6cVb3nMq8wEr1tYu4iOp7aSd2fGh5j", pinPepper: "Qw8eRt5yUi2oPa7sDf4gHj1kLz9xCv3b" };

describe("how long the till may sit untouched", () => {
  it("3 minutes unless told otherwise", () => {
    expect(DEFAULT_POS_IDLE_SECONDS).toBe(180);
    expect(posIdleSeconds({})).toBe(180);
  });

  it("takes a whole number of seconds, and 0 turns it off", () => {
    expect(posIdleSeconds({ POS_IDLE_LOCK_SECONDS: "30" })).toBe(30);
    expect(posIdleSeconds({ POS_IDLE_LOCK_SECONDS: "0" })).toBe(0);
    expect(posIdleSeconds({ POS_IDLE_LOCK_SECONDS: "86400" })).toBe(86_400);
  });

  it("falls back to the default for anything else rather than guessing", () => {
    for (const bad of ["", " ", "abc", "-5", "1.5", "1e3", "30s", " 30", "30 ", "86401", "99999999999", "٣٠"]) {
      expect(posIdleSeconds({ POS_IDLE_LOCK_SECONDS: bad }), JSON.stringify(bad)).toBe(180);
    }
  });
});

describe("which idle time the till uses: the deployment's override, then the shop's setting, then 3 minutes", () => {
  it("the override beats the setting", () => {
    expect(posIdleSeconds({ POS_IDLE_LOCK_SECONDS: "5" }, 600)).toBe(5);
    expect(posIdleSeconds({ POS_IDLE_LOCK_SECONDS: "0" }, 600)).toBe(0);
  });
  it("without an override the shop's setting is used (0 turns the lock off)", () => {
    expect(posIdleSeconds({}, 600)).toBe(600);
    expect(posIdleSeconds({}, 0)).toBe(0);
    expect(posIdleSeconds({}, 86_400)).toBe(86_400);
  });
  it("a setting or an override that makes no sense is skipped", () => {
    for (const bad of [-1, 1.5, 86_401, "60", null, undefined, Number.NaN]) expect(posIdleSeconds({}, bad), String(bad)).toBe(180);
    expect(posIdleSeconds({ POS_IDLE_LOCK_SECONDS: "abc" }, 600)).toBe(600);
    expect(posIdleSeconds({ POS_IDLE_LOCK_SECONDS: "99999999" }, 600)).toBe(600);
    expect(posIdleSeconds({ POS_IDLE_LOCK_SECONDS: "" }, 600)).toBe(600);
  });
});

describe("the developer sign-in", () => {
  let admin: AdminDb;
  let db: TenantDb;

  beforeAll(async () => {
    admin = createAdminDb(inject("adminUrl"), { max: 2 });
    db = createTenantDb(inject("appUrl"), { max: 4 });
    // the demo shop exists for every test below, so a request that is wrongly let through would succeed
    await seedDemoShop(admin.sql, PEPPERS);
  });
  afterAll(async () => {
    await db.close();
    await admin.close();
  });

  const signIn = (env: Record<string, string | undefined>, options: { origin?: string | null; body?: unknown } = {}) => {
    const handler = createDevSignIn({ db, sessionSecret: SESSION_SECRET, appUrl: APP_URL, env });
    const headers = new Headers({ "content-type": "application/json" });
    const origin = options.origin === undefined ? APP_URL : options.origin;
    if (origin !== null) headers.set("origin", origin);
    return handler(new Request(`${APP_URL}/api/dev/sign-in`, { method: "POST", headers, body: JSON.stringify(options.body ?? {}) }));
  };
  const ON = { ALLOW_DEV_SIGN_IN: "1", NODE_ENV: "development" };

  it("does not exist unless the switch is on, and never in a production build", async () => {
    for (const env of [{}, { NODE_ENV: "development" }, { ALLOW_DEV_SIGN_IN: "1", NODE_ENV: "production" }, { ALLOW_DEV_SIGN_IN: "true", NODE_ENV: "development" }]) {
      const response = await signIn(env);
      expect(response.status, JSON.stringify(env)).toBe(404);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  it("with the switch on and a demo shop, signs in as the demo owner and sets the session cookie", async () => {
    await seedDemoShop(admin.sql, PEPPERS);
    const response = await signIn(ON);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ signedIn: true });
    const header = response.headers.get("set-cookie") ?? "";
    expect(header).toMatch(/^retail_session=/);
    expect(header).toContain("HttpOnly");
    const payload = await readSessionCookie(header.split(";")[0]?.split("=")[1] ?? "", SESSION_SECRET, Math.floor(Date.now() / 1000));
    expect(payload).not.toBeNull();
    const [staff] = await admin.sql`select auth_user_id, display_name from app.staff where id = ${payload?.staffId as string}`;
    expect(staff).toMatchObject({ auth_user_id: DEV_DEMO_OWNER_ACCOUNT_ID, display_name: "Demo Owner" });
    expect(payload?.deviceId).toBeUndefined(); // an admin sign-in, not a till
  });

  it("only ever signs in the one demo account: it takes no account from the caller", async () => {
    await seedDemoShop(admin.sql, PEPPERS);
    expect((await signIn(ON, { body: { authUserId: "00000000-0000-4000-8000-0000000000ff" } })).status).toBe(400);
    expect((await signIn(ON, { body: { anything: 1 } })).status).toBe(400);
  });

  it("must come from the app's own pages", async () => {
    expect((await signIn(ON, { origin: null })).status).toBe(403);
    expect((await signIn(ON, { origin: "http://evil.example" })).status).toBe(403);
  });
});
