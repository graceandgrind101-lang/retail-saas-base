import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { PERMISSIONS, defaultModulesFor, permissionsOfModules, signSessionCookie } from "@retail/core";
import { LastOwnerError, PinTooWeakError, SessionEndedError, StepUpInvalidError, createTenantDb, type TenantDb } from "@retail/db";
import { createAdminDb, provisionTenant, type AdminDb } from "@retail/db/admin";
import { newUuid } from "./ids";
import { createAuthHandlers } from "../lib/auth/handlers";
import { createTokenVerifier } from "../lib/auth/verify-token";
import { apiErrorResponse } from "../lib/http";
import { createPermissionHandlers } from "../lib/permissions/handlers";
import { TEST_ISSUER, TEST_JWT_SECRET, mintToken } from "./tokens";

const APP_URL = "http://localhost:3000";
const SESSION_SECRET = "k3Jf9aQ2xLm7ZpR1tVb8nWc4yHd6sGu0";

let admin: AdminDb;
let db: TenantDb;
let auth: ReturnType<typeof createAuthHandlers>;
let handlers: ReturnType<typeof createPermissionHandlers>;

beforeAll(() => {
  admin = createAdminDb(inject("adminUrl"), { max: 3 });
  db = createTenantDb(inject("appUrl"), { max: 6 });
  auth = createAuthHandlers({ db, verifyToken: createTokenVerifier({ issuer: TEST_ISSUER, jwtSecret: TEST_JWT_SECRET }), sessionSecret: SESSION_SECRET, appUrl: APP_URL });
  handlers = createPermissionHandlers({ db, sessionSecret: SESSION_SECRET, appUrl: APP_URL });
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
  cookie?: string;
  token?: string;
}
function request(method: "GET" | "POST", path: string, options: Options = {}): Request {
  const headers = new Headers();
  const origin = options.origin === undefined ? APP_URL : options.origin;
  if (origin !== null) headers.set("origin", origin);
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  const body = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request(`${APP_URL}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
}

interface ApiBody {
  error?: string;
  id?: string;
  changed?: boolean;
  removed?: boolean;
  permissions?: string[];
  staff?: { role: string };
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
  await auth.acceptInvite(request("POST", "/api/auth/invite/accept", { token, body: { token: created.ownerInvite?.token } }));
  const started = await auth.startSession(request("POST", "/api/auth/session", { token, body: { tenantId: created.tenantId } }));
  expect(started.status).toBe(200);
  const [owner] = await admin.sql`select id from app.staff where tenant_id = ${created.tenantId} and auth_user_id is not null`;
  return { tenantId: created.tenantId, roleIds: created.roleIds as Record<string, string>, ownerCookie: cookieFrom(started), ownerId: owner?.id as string };
}
type Shop = Awaited<ReturnType<typeof shop>>;

/** Someone with a role and a live sign-in, as a browser cookie (made with the owner login, like the console). */
async function person(s: Shop, roleKey: "manager" | "cashier" | "viewer") {
  const staffId = newUuid();
  const sessionId = newUuid();
  await admin.sql`insert into app.staff (id, tenant_id, display_name, role_id, status) values (${staffId}, ${s.tenantId}, ${`${roleKey} ${suffix()}`}, ${s.roleIds[roleKey] as string}, 'active')`;
  await admin.sql`insert into app.staff_sessions (id, tenant_id, staff_id, method, expires_at) values (${sessionId}, ${s.tenantId}, ${staffId}, 'password', now() + interval '1 day')`;
  const value = await signSessionCookie({ tenantId: s.tenantId, staffId, sessionId, expiresAt: Math.floor(Date.now() / 1000) + 3600 }, SESSION_SECRET);
  return { staffId, cookie: `retail_session=${value}` };
}

const post = (fn: (r: Request) => Promise<Response>, path: string, cookie: string | undefined, body: unknown, extra: Options = {}) =>
  fn(request("POST", path, { ...(cookie ? { cookie } : {}), body, ...extra }));

describe("who the signed-in person is allowed to be", () => {
  it("/me lists exactly what the person may do: everything on for the owner, the template for a cashier", async () => {
    const s = await shop("me");
    const cashier = await person(s, "cashier");
    const owner = await json(await auth.me(request("GET", "/api/auth/me", { cookie: s.ownerCookie })));
    expect(owner.permissions).toEqual([...permissionsOfModules(defaultModulesFor("electronics"))].sort());
    expect(PERMISSIONS.length).toBeGreaterThan(owner.permissions?.length ?? 0);
    const seen = await json(await auth.me(request("GET", "/api/auth/me", { cookie: cashier.cookie })));
    expect(seen.permissions).toContain("sale:create");
    expect(seen.permissions).not.toContain("staff:manage");
    expect(seen.permissions).toEqual([...(seen.permissions ?? [])].sort());
  });
});

describe("adding people and changing roles over HTTP", () => {
  it("an owner adds a cashier with no login account; a cashier cannot add anyone", async () => {
    const s = await shop("create");
    const made = await post(handlers.createStaff, "/api/staff", s.ownerCookie, { displayName: "  New Cashier ", roleId: s.roleIds.cashier, phone: "0911000000" });
    expect(made.status).toBe(200);
    const { id } = await json(made);
    const [row] = await admin.sql`select display_name, status, auth_user_id, role_id from app.staff where id = ${id as string}`;
    expect(row).toMatchObject({ display_name: "New Cashier", status: "active", auth_user_id: null, role_id: s.roleIds.cashier });

    const cashier = await person(s, "cashier");
    const denied = await post(handlers.createStaff, "/api/staff", cashier.cookie, { displayName: "Nope", roleId: s.roleIds.viewer });
    expect(denied.status).toBe(403);
    expect(await json(denied)).toEqual({ error: "forbidden" });
  });

  it("a manager can add a cashier but not an owner; changing a role follows the same rules", async () => {
    const s = await shop("role");
    const manager = await person(s, "manager");
    const cashier = await person(s, "cashier");
    expect((await post(handlers.createStaff, "/api/staff", manager.cookie, { displayName: "Fine", roleId: s.roleIds.cashier })).status).toBe(200);
    expect((await post(handlers.createStaff, "/api/staff", manager.cookie, { displayName: "Too much", roleId: s.roleIds.owner })).status).toBe(403);
    expect((await post(handlers.setStaffRole, "/api/staff/role", manager.cookie, { staffId: cashier.staffId, roleId: s.roleIds.manager })).status).toBe(200);
    expect((await post(handlers.setStaffRole, "/api/staff/role", manager.cookie, { staffId: cashier.staffId, roleId: s.roleIds.owner })).status).toBe(403);
    expect((await post(handlers.setStaffRole, "/api/staff/role", manager.cookie, { staffId: manager.staffId, roleId: s.roleIds.cashier })).status).toBe(403); // not yourself
    expect((await post(handlers.setStaffRole, "/api/staff/role", manager.cookie, { staffId: s.ownerId, roleId: s.roleIds.cashier })).status).toBe(403); // not an owner
    const me = await json(await auth.me(request("GET", "/api/auth/me", { cookie: cashier.cookie })));
    expect(me.staff?.role).toBe("manager");
  });

  it("the shape is checked: bodies, ids, origin, session", async () => {
    const s = await shop("shape");
    const bad = (body: unknown, extra: Options = {}) => post(handlers.createStaff, "/api/staff", s.ownerCookie, body, extra);
    expect((await bad({ displayName: "", roleId: s.roleIds.cashier })).status).toBe(400);
    expect((await bad({ displayName: "x".repeat(81), roleId: s.roleIds.cashier })).status).toBe(400);
    expect((await bad({ displayName: "x", roleId: "nope" })).status).toBe(400);
    expect((await bad({ displayName: "x", roleId: s.roleIds.cashier, admin: true })).status).toBe(400);
    expect((await bad({ displayName: "x", roleId: s.roleIds.cashier, branchIds: ["nope"] })).status).toBe(400);
    expect((await bad({}, { rawBody: "not json" })).status).toBe(400);
    expect((await bad({ displayName: "x", roleId: s.roleIds.cashier }, { origin: null })).status).toBe(403);
    expect((await bad({ displayName: "x", roleId: s.roleIds.cashier }, { origin: "http://evil.example" })).status).toBe(403);
    expect((await post(handlers.createStaff, "/api/staff", undefined, { displayName: "x", roleId: s.roleIds.cashier })).status).toBe(401);
    expect((await bad({ displayName: "x", roleId: newUuid() })).status).toBe(400); // unknown role
  });
});

describe("suspending and archiving people over HTTP", () => {
  it("a manager suspends and reinstates a cashier; a cashier, themselves, an owner and an archived person are refused", async () => {
    const s = await shop("status");
    const manager = await person(s, "manager");
    const cashier = await person(s, "cashier");
    const other = await person(s, "viewer");
    const status = (cookie: string | undefined, staffId: string, value: string, extra: Options = {}) => post(handlers.setStaffStatus, "/api/staff/status", cookie, { staffId, status: value }, extra);
    const read = async (id: string) => ((await admin.sql`select status from app.staff where id = ${id}`)[0] as { status: string }).status;

    expect((await status(manager.cookie, other.staffId, "suspended")).status).toBe(200);
    expect(await read(other.staffId)).toBe("suspended");
    expect((await status(manager.cookie, other.staffId, "active")).status).toBe(200);
    expect(await read(other.staffId)).toBe("active");

    expect((await status(cashier.cookie, other.staffId, "suspended")).status).toBe(403); // no staff:manage
    expect((await status(manager.cookie, manager.staffId, "suspended")).status).toBe(403); // not yourself
    expect((await status(manager.cookie, s.ownerId, "suspended")).status).toBe(403); // not above you
    expect(await read(s.ownerId)).toBe("active");

    expect((await status(manager.cookie, other.staffId, "archived")).status).toBe(200);
    expect((await status(manager.cookie, other.staffId, "active")).status).toBe(400); // archived is final here
    expect(await read(other.staffId)).toBe("archived");
  });

  it("the shape is checked: status values, ids, extra fields, origin, session", async () => {
    const s = await shop("statusshape");
    const cashier = await person(s, "cashier");
    const go = (body: unknown, extra: Options = {}) => post(handlers.setStaffStatus, "/api/staff/status", s.ownerCookie, body, extra);
    expect((await go({ staffId: cashier.staffId, status: "deleted" })).status).toBe(400);
    expect((await go({ staffId: cashier.staffId, status: "invited" })).status).toBe(400);
    expect((await go({ staffId: "nope", status: "suspended" })).status).toBe(400);
    expect((await go({ staffId: cashier.staffId, status: "suspended", extra: 1 })).status).toBe(400);
    expect((await go({ staffId: cashier.staffId, status: "suspended" }, { origin: "http://evil.example" })).status).toBe(403);
    expect((await post(handlers.setStaffStatus, "/api/staff/status", undefined, { staffId: cashier.staffId, status: "suspended" })).status).toBe(401);
  });
});

describe("personal exceptions and custom roles over HTTP", () => {
  it("an owner allows and denies keys with a reason; the person's /me changes at once", async () => {
    const s = await shop("override");
    const cashier = await person(s, "cashier");
    const before = await json(await auth.me(request("GET", "/api/auth/me", { cookie: cashier.cookie })));
    expect(before.permissions).not.toContain("sale:void");
    expect((await post(handlers.setOverride, "/api/staff/overrides", s.ownerCookie, { staffId: cashier.staffId, key: "sale:void", effect: "allow", reason: "trusted" })).status).toBe(200);
    expect((await post(handlers.setOverride, "/api/staff/overrides", s.ownerCookie, { staffId: cashier.staffId, key: "sale:create", effect: "deny", reason: "probation" })).status).toBe(200);
    const after = await json(await auth.me(request("GET", "/api/auth/me", { cookie: cashier.cookie })));
    expect(after.permissions).toContain("sale:void");
    expect(after.permissions).not.toContain("sale:create");
    const removed = await post(handlers.removeOverride, "/api/staff/overrides/remove", s.ownerCookie, { staffId: cashier.staffId, key: "sale:create" });
    expect(await json(removed)).toEqual({ removed: true });
    expect(await json(await post(handlers.removeOverride, "/api/staff/overrides/remove", s.ownerCookie, { staffId: cashier.staffId, key: "sale:create" }))).toEqual({ removed: false });
  });

  it("unknown keys, missing reasons and self-service are refused", async () => {
    const s = await shop("override2");
    const manager = await person(s, "manager");
    const cashier = await person(s, "cashier");
    const set = (cookie: string, body: Record<string, unknown>) => post(handlers.setOverride, "/api/staff/overrides", cookie, body);
    const base = { staffId: cashier.staffId, key: "sale:void", effect: "allow", reason: "x" };
    expect((await set(s.ownerCookie, { ...base, key: "nope:nope" })).status).toBe(400);
    expect((await set(s.ownerCookie, { ...base, reason: "" })).status).toBe(400);
    expect((await set(s.ownerCookie, { ...base, reason: "   " })).status).toBe(400);
    expect((await set(s.ownerCookie, { ...base, effect: "maybe" })).status).toBe(400);
    expect((await set(manager.cookie, { ...base, staffId: manager.staffId })).status).toBe(403);
    expect((await set(manager.cookie, { ...base, key: "role:manage" })).status).toBe(403); // a key the manager lacks
    expect((await set(cashier.cookie, { ...base, staffId: manager.staffId })).status).toBe(403);
  });

  it("a custom role is changed only by someone with role:manage, never a system role", async () => {
    const s = await shop("roleperm");
    const manager = await person(s, "manager");
    const roleId = newUuid();
    await admin.sql`insert into app.roles (id, tenant_id, key, name) values (${roleId}, ${s.tenantId}, 'seller', '{"en": "Seller"}'::jsonb)`;
    const grant = (cookie: string, body: Record<string, unknown>) => post(handlers.setRolePermission, "/api/roles/permissions", cookie, body);
    expect((await grant(s.ownerCookie, { roleId, key: "sale:view", granted: true })).status).toBe(200);
    expect((await admin.sql`select 1 from app.role_permissions where role_id = ${roleId}`).length).toBe(1);
    expect((await grant(manager.cookie, { roleId, key: "sale:create", granted: true })).status).toBe(403);
    expect((await grant(s.ownerCookie, { roleId: s.roleIds.cashier, key: "sale:void", granted: true })).status).toBe(403);
    expect((await grant(s.ownerCookie, { roleId, key: "nope:nope", granted: true })).status).toBe(400);
    expect((await grant(s.ownerCookie, { roleId, key: "sale:view", granted: "yes" })).status).toBe(400);
    expect((await grant(s.ownerCookie, { roleId, key: "sale:view", granted: false })).status).toBe(200);
    expect((await admin.sql`select 1 from app.role_permissions where role_id = ${roleId}`).length).toBe(0);
  });
});

describe("what the browser is told when something goes wrong", () => {
  const clear = { "set-cookie": "x=; Max-Age=0" };
  it("maps each failure to a short fixed code", async () => {
    const body = async (error: unknown) => {
      const response = apiErrorResponse(error, "test", clear);
      return { status: response.status, body: await response.json(), cleared: response.headers.get("set-cookie") === "x=; Max-Age=0" };
    };
    expect(await body(new LastOwnerError())).toEqual({ status: 409, body: { error: "last_owner" }, cleared: false });
    expect(await body(new SessionEndedError())).toEqual({ status: 401, body: { error: "session_ended" }, cleared: true });
    expect(await body(new StepUpInvalidError())).toEqual({ status: 403, body: { error: "approval_invalid" }, cleared: false });
    expect(await body(new PinTooWeakError("too_easy"))).toEqual({ status: 400, body: { error: "pin_weak", problem: "too_easy" }, cleared: false });
    expect(await body({ code: "42501", message: "secret detail" })).toEqual({ status: 403, body: { error: "forbidden" }, cleared: false });
    expect(await body({ cause: { code: "23514", message: "secret detail" } })).toEqual({ status: 400, body: { error: "bad_request" }, cleared: false });
    expect(await body(new Error("password=hunter2"))).toEqual({ status: 500, body: { error: "server_error" }, cleared: false });
  });
});
