import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { readSessionCookie, parseCookieHeader } from "@retail/core";
import { createTenantDb, type TenantDb } from "@retail/db";
import { createAdminDb, provisionTenant, type AdminDb } from "@retail/db/admin";
import { newUuid } from "./ids";
import { createAuthHandlers } from "../lib/auth/handlers";
import { createTokenVerifier } from "../lib/auth/verify-token";
import { clientKey, createDeviceHandlers } from "../lib/devices/handlers";
import { TEST_ISSUER, TEST_JWT_SECRET, mintToken } from "./tokens";

const APP_URL = "http://localhost:3000";
const SESSION_SECRET = "k3Jf9aQ2xLm7ZpR1tVb8nWc4yHd6sGu0";
const PEPPERS = { devicePepper: "Zx6cVb3nMq8wEr1tYu4iOp7aSd2fGh5j", pinPepper: "Qw8eRt5yUi2oPa7sDf4gHj1kLz9xCv3b" };

let admin: AdminDb;
let db: TenantDb;
let auth: ReturnType<typeof createAuthHandlers>;
let devices: ReturnType<typeof createDeviceHandlers>;

beforeAll(() => {
  admin = createAdminDb(inject("adminUrl"), { max: 3 });
  db = createTenantDb(inject("appUrl"), { max: 8 });
  auth = createAuthHandlers({
    db,
    verifyToken: createTokenVerifier({ issuer: TEST_ISSUER, jwtSecret: TEST_JWT_SECRET }),
    sessionSecret: SESSION_SECRET,
    appUrl: APP_URL,
  });
  devices = createDeviceHandlers({ db, peppers: PEPPERS, sessionSecret: SESSION_SECRET, appUrl: APP_URL });
});
afterAll(async () => {
  await db.close();
  await admin.close();
});

const suffix = () => randomBytes(4).toString("hex");

interface Options {
  body?: unknown;
  rawBody?: string;
  origin?: string | null;
  cookies?: string[];
  headers?: Record<string, string>;
  token?: string;
}

function request(method: "GET" | "POST", path: string, options: Options = {}): Request {
  const headers = new Headers(options.headers);
  const origin = options.origin === undefined ? APP_URL : options.origin;
  if (origin !== null) headers.set("origin", origin);
  if (options.cookies?.length) headers.set("cookie", options.cookies.join("; "));
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  const body = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request(`${APP_URL}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
}

interface ApiBody {
  error?: string;
  problem?: string;
  code?: string;
  expiresAt?: string;
  deviceId?: string;
  tenantId?: string;
  branchId?: string;
  verificationId?: string;
  set?: boolean;
  revoked?: boolean;
  unlocked?: boolean;
  device?: { id: string; name: string; lockedUntil: string | null };
  shop?: { slug: string };
  staff?: { id: string; name: string; locked: boolean }[] | { id: string };
}
const json = async (response: Response): Promise<ApiBody> => (await response.json()) as ApiBody;
const cookieFrom = (response: Response): string => (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

async function shop(prefix: string) {
  const email = `owner-${suffix()}@example.com`;
  const created = await provisionTenant(admin.sql, {
    slug: `${prefix}-${suffix()}`,
    displayName: { en: `Shop ${prefix}` },
    industry: "electronics",
    planKey: "pro",
    owner: { email, displayName: "Owner Person" },
  });
  const token = await mintToken({ sub: newUuid(), email, provider: "google" });
  const accepted = await auth.acceptInvite(request("POST", "/api/auth/invite/accept", { token, body: { token: created.ownerInvite?.token } }));
  expect(accepted.status).toBe(200);
  const started = await auth.startSession(request("POST", "/api/auth/session", { token, body: { tenantId: created.tenantId } }));
  expect(started.status).toBe(200);
  const ownerCookie = cookieFrom(started);
  const [owner] = await admin.sql`select id from app.staff where tenant_id = ${created.tenantId} and auth_user_id is not null`;
  return { tenantId: created.tenantId, branchId: created.branchId, ownerCookie, ownerId: owner?.id as string };
}
type Shop = Awaited<ReturnType<typeof shop>>;

async function addStaff(s: Shop, roleKey: "manager" | "cashier", pin?: string): Promise<string> {
  const id = newUuid();
  const [role] = await admin.sql`select id from app.roles where tenant_id = ${s.tenantId} and key = ${roleKey}`;
  await admin.sql`insert into app.staff (id, tenant_id, display_name, role_id, status) values (${id}, ${s.tenantId}, ${`${roleKey} ${suffix()}`}, ${role?.id}, 'active')`;
  if (pin) {
    const response = await devices.setPin(request("POST", "/api/staff/pin", { cookies: [s.ownerCookie], body: { staffId: id, pin } }));
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
  }
  return id;
}

/** Owner makes a code, the new device pairs. Returns the device cookie a browser would keep. */
async function pairedDevice(s: Shop, address = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`) {
  const made = await devices.createPairingCode(request("POST", "/api/devices/pairing-codes", { cookies: [s.ownerCookie], body: { branchId: s.branchId } }));
  expect(made.status).toBe(200);
  const { code } = await json(made);
  const paired = await devices.pairDevice(request("POST", "/api/devices/pair", { body: { code, name: "Counter 1", kind: "pos" }, headers: { "cf-connecting-ip": `${address}-${suffix()}` } }));
  expect(paired.status, JSON.stringify(await paired.clone().json())).toBe(200);
  return { deviceCookie: cookieFrom(paired), ...(await json(paired)) };
}

const signIn = (deviceCookie: string, staffId: string, pin: string, extra: Options = {}) =>
  devices.pinSignIn(request("POST", "/api/devices/pin-sign-in", { cookies: [deviceCookie], body: { staffId, pin }, ...extra }));

describe("pairing over HTTP", () => {
  it("an owner makes a code, the new device pairs and keeps its secret in an HttpOnly cookie, never in the body", async () => {
    const s = await shop("pair");
    const made = await devices.createPairingCode(request("POST", "/api/devices/pairing-codes", { cookies: [s.ownerCookie], body: { branchId: s.branchId } }));
    expect(made.status).toBe(200);
    const { code, expiresAt } = await json(made);
    expect(code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
    expect(new Date(expiresAt ?? "").getTime()).toBeGreaterThan(Date.now());

    const paired = await devices.pairDevice(request("POST", "/api/devices/pair", { body: { code, name: "Counter 1", kind: "pos" } }));
    expect(paired.status).toBe(200);
    const header = paired.headers.get("set-cookie") ?? "";
    expect(header).toMatch(/^retail_device=[A-Za-z0-9_-]{43};/);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    const token = header.split(";")[0]?.split("=")[1] ?? "";
    const text = await paired.text();
    expect(text).not.toContain(token);
    expect(JSON.parse(text)).toMatchObject({ tenantId: s.tenantId, branchId: s.branchId });

    const again = await devices.pairDevice(request("POST", "/api/devices/pair", { body: { code, name: "Counter 2", kind: "pos" } }));
    expect(again.status).toBe(400);
    expect(await json(again)).toEqual({ error: "pairing_invalid" });
  });

  it("the till status lists the device, the shop and who can sign in; an unknown cookie is told to pair again", async () => {
    const s = await shop("status");
    const cashier = await addStaff(s, "cashier", "4829");
    const d = await pairedDevice(s);
    const status = await devices.deviceStatus(request("GET", "/api/devices/me", { cookies: [d.deviceCookie] }));
    expect(status.status).toBe(200);
    const b = await json(status);
    expect(b.device).toMatchObject({ id: d.deviceId, name: "Counter 1", lockedUntil: null });
    expect(b.shop?.slug).toContain("status-");
    expect((b.staff as { id: string }[]).map((x) => x.id)).toContain(cashier);
    expect(JSON.stringify(b)).not.toMatch(/pin|hash/i);

    for (const cookies of [[], ["retail_device=" + "x".repeat(43)], ["retail_device=junk"]]) {
      const unknown = await devices.deviceStatus(request("GET", "/api/devices/me", { cookies }));
      expect(unknown.status).toBe(401);
      expect(await json(unknown)).toEqual({ error: "device_unknown" });
    }
  });

  it("pairing needs the app's own origin, a well-formed body, and is capped per caller", async () => {
    const s = await shop("cap");
    const bad = (options: Options) => devices.pairDevice(request("POST", "/api/devices/pair", options));
    expect((await bad({ origin: null, body: { code: "ABCD-2345", name: "T", kind: "pos" } })).status).toBe(403);
    expect((await bad({ origin: "http://evil.example", body: { code: "ABCD-2345", name: "T", kind: "pos" } })).status).toBe(403);
    expect((await bad({ body: { code: "ABCD-2345", name: "T", kind: "toaster" } })).status).toBe(400);
    expect((await bad({ body: { code: "ABCD-2345", name: "", kind: "pos" } })).status).toBe(400);
    expect((await bad({ body: { code: "ABCD-2345", name: "T", kind: "pos", extra: 1 } })).status).toBe(400);
    expect((await bad({ rawBody: "not json" })).status).toBe(400);

    const headers = { "cf-connecting-ip": `203.0.113.${Math.floor(Math.random() * 200)}-${suffix()}` };
    const guess = () => bad({ body: { code: "ABCD-2345", name: "T", kind: "pos" }, headers });
    for (let i = 0; i < 10; i++) expect((await guess()).status).toBe(400);
    const limited = await guess();
    expect(limited.status).toBe(429);
    expect(await json(limited)).toEqual({ error: "rate_limited" });
    expect(s.tenantId).toBeDefined();
  });

  it("only an owner or manager can make a code; a cashier gets 'forbidden'; nobody without a session can", async () => {
    const s = await shop("who");
    const cashier = await addStaff(s, "cashier", "4829");
    const d = await pairedDevice(s);
    const signed = await signIn(d.deviceCookie, cashier, "4829");
    const cashierCookie = cookieFrom(signed);
    const denied = await devices.createPairingCode(request("POST", "/api/devices/pairing-codes", { cookies: [cashierCookie], body: { branchId: s.branchId } }));
    expect(denied.status).toBe(403);
    expect(await json(denied)).toEqual({ error: "forbidden" });
    const anonymous = await devices.createPairingCode(request("POST", "/api/devices/pairing-codes", { body: { branchId: s.branchId } }));
    expect(anonymous.status).toBe(401);
    const noOrigin = await devices.createPairingCode(request("POST", "/api/devices/pairing-codes", { origin: null, cookies: [s.ownerCookie], body: { branchId: s.branchId } }));
    expect(noOrigin.status).toBe(403);
  });
});

describe("PIN sign-in over HTTP", () => {
  it("signs in, sets a 12 hour session cookie that names the device, and the session works", async () => {
    const s = await shop("signin");
    const cashier = await addStaff(s, "cashier", "4829");
    const d = await pairedDevice(s);
    const response = await signIn(d.deviceCookie, cashier, "4829");
    expect(response.status).toBe(200);
    const header = response.headers.get("set-cookie") ?? "";
    expect(header).toMatch(/^retail_session=/);
    expect(header).toContain("HttpOnly");
    const maxAge = Number(/Max-Age=(\d+)/.exec(header)?.[1]);
    expect(maxAge).toBeGreaterThan(11.9 * 3600);
    expect(maxAge).toBeLessThanOrEqual(12 * 3600);

    const value = parseCookieHeader(cookieFrom(response))["retail_session"] ?? "";
    const payload = await readSessionCookie(value, SESSION_SECRET, Math.floor(Date.now() / 1000));
    expect(payload).toMatchObject({ tenantId: s.tenantId, staffId: cashier, deviceId: d.deviceId });

    const me = await auth.me(request("GET", "/api/auth/me", { cookies: [cookieFrom(response)] }));
    expect(me.status).toBe(200);
    const who = (await me.json()) as { staff: { id: string; role: string } };
    expect(who.staff).toMatchObject({ id: cashier, role: "cashier" });
  });

  it("a wrong PIN is 401, five lock with 423, and nothing about the PIN or the hash is ever in a body", async () => {
    const s = await shop("wrong");
    const cashier = await addStaff(s, "cashier", "4829");
    const d = await pairedDevice(s);
    const first = await signIn(d.deviceCookie, cashier, "0000");
    expect(first.status).toBe(401);
    expect(await json(first)).toEqual({ error: "wrong_pin" });
    for (let i = 0; i < 4; i++) await signIn(d.deviceCookie, cashier, "0000");
    const locked = await signIn(d.deviceCookie, cashier, "4829");
    expect(locked.status).toBe(423);
    expect(await json(locked)).toEqual({ error: "locked" });
    expect(locked.headers.get("set-cookie")).toBeNull();
  });

  it("needs the device cookie, the app's origin, a PIN of 4 to 6 digits and a real staff id", async () => {
    const s = await shop("shape");
    const cashier = await addStaff(s, "cashier", "4829");
    const d = await pairedDevice(s);
    expect((await devices.pinSignIn(request("POST", "/api/devices/pin-sign-in", { body: { staffId: cashier, pin: "4829" } }))).status).toBe(401);
    expect((await signIn(d.deviceCookie, cashier, "4829", { origin: null })).status).toBe(403);
    expect((await signIn(d.deviceCookie, cashier, "4829", { origin: "http://evil.example" })).status).toBe(403);
    for (const pin of ["", "123", "1234567", "12a4", "٤٨٢٩"]) expect((await signIn(d.deviceCookie, cashier, pin)).status, pin).toBe(400);
    expect((await signIn(d.deviceCookie, "not-a-uuid", "4829")).status).toBe(400);
    expect((await signIn(d.deviceCookie, cashier, "4829", { rawBody: JSON.stringify({ staffId: cashier, pin: "4829", admin: true }) })).status).toBe(400);
    expect((await signIn(d.deviceCookie, newUuid(), "4829")).status).toBe(403);
    expect(await json(await signIn(d.deviceCookie, newUuid(), "4829"))).toEqual({ error: "cannot_sign_in" });
  });

  it("a revoked device: its sessions end at once, its cookie is forgotten, and nobody can sign in on it", async () => {
    const s = await shop("revoke");
    const cashier = await addStaff(s, "cashier", "4829");
    const d = await pairedDevice(s);
    const cashierCookie = cookieFrom(await signIn(d.deviceCookie, cashier, "4829"));
    expect((await auth.me(request("GET", "/api/auth/me", { cookies: [cashierCookie] }))).status).toBe(200);

    const revoked = await devices.revokeDevice(request("POST", "/api/devices/revoke", { cookies: [s.ownerCookie], body: { deviceId: d.deviceId } }));
    expect(await json(revoked)).toEqual({ revoked: true });
    const afterwards = await auth.me(request("GET", "/api/auth/me", { cookies: [cashierCookie] }));
    expect(afterwards.status).toBe(401);
    expect(await json(afterwards)).toEqual({ error: "session_ended" });

    const refused = await signIn(d.deviceCookie, cashier, "4829");
    expect(refused.status).toBe(401);
    expect(await json(refused)).toEqual({ error: "device_unknown" });
    expect(refused.headers.get("set-cookie")).toMatch(/^retail_device=;.*Max-Age=0/);
    expect((await devices.deviceStatus(request("GET", "/api/devices/me", { cookies: [d.deviceCookie] }))).status).toBe(401);
  });

  it("a manager can open a locked till; a cashier cannot", async () => {
    const s = await shop("unlock");
    const cashier = await addStaff(s, "cashier", "4829");
    const other = await addStaff(s, "cashier", "7391");
    const d = await pairedDevice(s);
    const second = await pairedDevice(s);
    const otherCookie = cookieFrom(await signIn(second.deviceCookie, other, "7391"));
    for (let i = 0; i < 5; i++) await signIn(d.deviceCookie, cashier, "0000");
    expect((await signIn(d.deviceCookie, other, "7391")).status).toBe(423);
    const denied = await devices.unlockDevice(request("POST", "/api/devices/unlock", { cookies: [otherCookie], body: { deviceId: d.deviceId } }));
    expect(denied.status).toBe(403);
    const opened = await devices.unlockDevice(request("POST", "/api/devices/unlock", { cookies: [s.ownerCookie], body: { deviceId: d.deviceId } }));
    expect(await json(opened)).toEqual({ unlocked: true });
    expect((await signIn(d.deviceCookie, other, "7391")).status).toBe(200);
  });
});

describe("setting PINs over HTTP", () => {
  it("refuses weak PINs with the reason, and a cashier cannot set another person's", async () => {
    const s = await shop("setpin");
    const cashier = await addStaff(s, "cashier");
    const other = await addStaff(s, "cashier", "7391");
    const weak = await devices.setPin(request("POST", "/api/staff/pin", { cookies: [s.ownerCookie], body: { staffId: cashier, pin: "1234" } }));
    expect(weak.status).toBe(400);
    expect(await json(weak)).toEqual({ error: "pin_weak", problem: "too_easy" });
    expect(await json(await devices.setPin(request("POST", "/api/staff/pin", { cookies: [s.ownerCookie], body: { staffId: cashier, pin: "12" } })))).toEqual({ error: "pin_weak", problem: "too_short" });
    expect((await devices.setPin(request("POST", "/api/staff/pin", { cookies: [s.ownerCookie], body: { staffId: cashier, pin: "4829" } }))).status).toBe(200);

    const d = await pairedDevice(s);
    const otherCookie = cookieFrom(await signIn(d.deviceCookie, other, "7391"));
    const denied = await devices.setPin(request("POST", "/api/staff/pin", { cookies: [otherCookie], body: { staffId: cashier, pin: "5062" } }));
    expect(denied.status).toBe(403);
    expect(await json(denied)).toEqual({ error: "forbidden" });
    expect((await devices.setPin(request("POST", "/api/staff/pin", { cookies: [otherCookie], body: { staffId: other, pin: "5062" } }))).status).toBe(200);
  });
});

describe("one-time approval over HTTP", () => {
  it("a manager's PIN approves one action on the cashier's till; wrong PINs are 403 and count", async () => {
    const s = await shop("step");
    const manager = await addStaff(s, "manager", "4829");
    const cashier = await addStaff(s, "cashier", "7391");
    const d = await pairedDevice(s);
    const cashierCookie = cookieFrom(await signIn(d.deviceCookie, cashier, "7391"));
    const ask = (pin: string, extra: Record<string, unknown> = {}, cookies = [cashierCookie]) =>
      devices.stepUp(request("POST", "/api/step-up", { cookies, body: { approverId: manager, pin, actionKey: "sale:below_floor", ...extra } }));

    const wrong = await ask("0000");
    expect(wrong.status).toBe(403);
    expect(await json(wrong)).toEqual({ error: "wrong_pin" });
    const ok = await ask("4829");
    expect(ok.status).toBe(200);
    const approved = await json(ok);
    expect(approved.verificationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(approved.expiresAt ?? "").getTime() - Date.now()).toBeLessThanOrEqual(120_000);

    expect((await ask("4829", { actionKey: "Not An Action" })).status).toBe(400);
    expect((await ask("4829", {}, [])).status).toBe(401);
    expect((await devices.stepUp(request("POST", "/api/step-up", { origin: null, cookies: [cashierCookie], body: { approverId: manager, pin: "4829", actionKey: "a:b" } }))).status).toBe(403);
    expect(await json(await ask("4829", { approverId: newUuid() }))).toEqual({ error: "cannot_approve" });
    for (let i = 0; i < 5; i++) await ask("0000");
    const locked = await ask("4829");
    expect(locked.status).toBe(423);
  });
});

describe("who is calling", () => {
  it("uses the Cloudflare address first, then the first forwarded address, then 'unknown'", () => {
    const get = (headers: Record<string, string>) => clientKey(new Request("http://x.test/", { headers }));
    expect(get({ "cf-connecting-ip": "198.51.100.7", "x-forwarded-for": "1.1.1.1" })).toBe("198.51.100.7");
    expect(get({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" })).toBe("203.0.113.9");
    expect(get({})).toBe("unknown");
    expect(get({ "cf-connecting-ip": "x".repeat(200) })).toHaveLength(64);
  });
});
