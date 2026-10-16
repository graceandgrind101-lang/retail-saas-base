import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { signSessionCookie } from "@retail/core";
import { createTenantDb, type TenantDb } from "@retail/db";
import { createAdminDb, provisionTenant, type AdminDb } from "@retail/db/admin";
import { newUuid } from "./ids";
import { createAlertHandlers } from "../lib/alerts/handlers";
import { createAuthHandlers } from "../lib/auth/handlers";
import { createTokenVerifier } from "../lib/auth/verify-token";
import { TEST_ISSUER, TEST_JWT_SECRET, mintToken } from "./tokens";

const APP_URL = "http://localhost:3000";
const SESSION_SECRET = "k3Jf9aQ2xLm7ZpR1tVb8nWc4yHd6sGu0";

let admin: AdminDb;
let db: TenantDb;
let alerts: ReturnType<typeof createAlertHandlers>;
let auth: ReturnType<typeof createAuthHandlers>;

beforeAll(() => {
  admin = createAdminDb(inject("adminUrl"), { max: 3 });
  db = createTenantDb(inject("appUrl"), { max: 6 });
  alerts = createAlertHandlers({ db, sessionSecret: SESSION_SECRET, appUrl: APP_URL });
  auth = createAuthHandlers({ db, verifyToken: createTokenVerifier({ issuer: TEST_ISSUER, jwtSecret: TEST_JWT_SECRET }), sessionSecret: SESSION_SECRET, appUrl: APP_URL });
});
afterAll(async () => {
  await db.close();
  await admin.close();
});

const suffix = () => randomBytes(4).toString("hex");

function request(method: "GET" | "POST", path: string, options: { body?: unknown; origin?: string | null; cookie?: string; token?: string } = {}): Request {
  const headers = new Headers();
  const origin = options.origin === undefined ? APP_URL : options.origin;
  if (origin !== null) headers.set("origin", origin);
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return new Request(`${APP_URL}${path}`, { method, headers, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
}

interface AlertJson {
  id: string;
  category: string;
  rule: string;
  severity: number;
  status: string;
  entity: { type: string; id: string } | null;
  note: string | null;
}
interface ListJson {
  error?: string;
  alerts?: AlertJson[];
  counts?: Record<string, number>;
  changed?: boolean;
}
const json = async (response: Response): Promise<ListJson> => (await response.json()) as ListJson;

async function shop(prefix: string) {
  const email = `owner-${suffix()}@example.com`;
  const created = await provisionTenant(admin.sql, { slug: `${prefix}-${suffix()}`, displayName: { en: `Shop ${prefix}` }, industry: "electronics", planKey: "pro", owner: { email, displayName: "Owner Person" } });
  const token = await mintToken({ sub: newUuid(), email, provider: "google" });
  await auth.acceptInvite(request("POST", "/api/auth/invite/accept", { token, body: { token: created.ownerInvite?.token } }));
  const started = await auth.startSession(request("POST", "/api/auth/session", { token, body: { tenantId: created.tenantId } }));
  expect(started.status).toBe(200);
  const ownerCookie = (started.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { tenantId: created.tenantId, roleIds: created.roleIds as Record<string, string>, ownerCookie };
}
type Shop = Awaited<ReturnType<typeof shop>>;

async function cookieFor(s: Shop, roleKey: "manager" | "cashier" | "viewer") {
  const staffId = newUuid();
  const sessionId = newUuid();
  await admin.sql`insert into app.staff (id, tenant_id, display_name, role_id, status) values (${staffId}, ${s.tenantId}, ${`${roleKey} ${suffix()}`}, ${s.roleIds[roleKey] as string}, 'active')`;
  await admin.sql`insert into app.staff_sessions (id, tenant_id, staff_id, method, expires_at) values (${sessionId}, ${s.tenantId}, ${staffId}, 'password', now() + interval '1 day')`;
  return `retail_session=${await signSessionCookie({ tenantId: s.tenantId, staffId, sessionId, expiresAt: Math.floor(Date.now() / 1000) + 3600 }, SESSION_SECRET)}`;
}

async function seed(s: Shop, category: string, rule: string, severity: number): Promise<string> {
  const id = newUuid();
  await admin.sql`insert into app.alerts (id, tenant_id, category, rule_key, severity, entity_type, entity_id, payload) values (${id}, ${s.tenantId}, ${category}, ${rule}, ${severity}, 'staff', ${newUuid()}, '{"a": 1}'::jsonb)`;
  return id;
}

describe("listing alerts over HTTP", () => {
  it("returns the open alerts and the count per category, in a fixed shape", async () => {
    const s = await shop("list");
    await seed(s, "fraud", "test.fraud", 5);
    await seed(s, "suspicion", "pin.staff_locked", 3);
    const closed = await seed(s, "info", "test.note", 1);
    expect((await alerts.setStatus(request("POST", "/api/alerts/status", { cookie: s.ownerCookie, body: { alertId: closed, status: "dismissed", note: "fine" } }))).status).toBe(200);

    const response = await alerts.list(request("GET", "/api/alerts", { cookie: s.ownerCookie }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await json(response);
    expect(body.counts).toEqual({ fraud: 1, suspicion: 1, error: 0, alert: 0, message: 0, info: 0 });
    expect(body.alerts).toHaveLength(2);
    expect(Object.keys(body.alerts?.[0] ?? {}).sort()).toEqual(["assigneeId", "branchId", "category", "createdAt", "entity", "id", "note", "payload", "resolvedAt", "resolvedBy", "rule", "severity", "status"]);
    expect(body.alerts?.[0]?.entity).toMatchObject({ type: "staff" });

    const dismissed = await json(await alerts.list(request("GET", "/api/alerts?status=dismissed", { cookie: s.ownerCookie })));
    expect(dismissed.alerts?.map((a) => a.id)).toEqual([closed]);
    expect(dismissed.alerts?.[0]?.note).toBe("fine");
    const fraud = await json(await alerts.list(request("GET", "/api/alerts?category=fraud,suspicion&limit=1", { cookie: s.ownerCookie })));
    expect(fraud.alerts).toHaveLength(1);
  });

  it("refuses bad queries instead of ignoring them", async () => {
    const s = await shop("query");
    for (const query of ["status=nope", "category=gossip", "limit=0", "limit=201", "limit=abc", "offset=-1", "colour=red", "status=new&status=ack", "status="]) {
      const response = await alerts.list(request("GET", `/api/alerts?${query}`, { cookie: s.ownerCookie }));
      expect(response.status, query).toBe(400);
      expect(await json(response)).toEqual({ error: "bad_request" });
    }
  });

  it("needs a sign-in, and alert:view: a cashier is 'forbidden'", async () => {
    const s = await shop("viewperm");
    const cashier = await cookieFor(s, "cashier");
    const viewer = await cookieFor(s, "viewer");
    expect((await alerts.list(request("GET", "/api/alerts"))).status).toBe(401);
    expect((await alerts.list(request("GET", "/api/alerts", { cookie: "retail_session=junk" }))).status).toBe(401);
    const denied = await alerts.list(request("GET", "/api/alerts", { cookie: cashier }));
    expect(denied.status).toBe(403);
    expect(await json(denied)).toEqual({ error: "forbidden" });
    expect((await alerts.list(request("GET", "/api/alerts", { cookie: viewer }))).status).toBe(200);
  });

  it("shows a shop only its own alerts", async () => {
    const a = await shop("iso-a");
    const b = await shop("iso-b");
    await seed(a, "fraud", "test.fraud", 5);
    expect((await json(await alerts.list(request("GET", "/api/alerts", { cookie: b.ownerCookie })))).alerts).toHaveLength(0);
  });
});

describe("closing alerts over HTTP", () => {
  it("acknowledge, then resolve; a viewer who can read cannot close; closed is final", async () => {
    const s = await shop("close");
    const viewer = await cookieFor(s, "viewer");
    const id = await seed(s, "suspicion", "pin.staff_locked", 3);
    const set = (cookie: string, body: unknown, extra: { origin?: string | null } = {}) => alerts.setStatus(request("POST", "/api/alerts/status", { cookie, body, ...extra }));

    expect((await set(viewer, { alertId: id, status: "ack" })).status).toBe(403);
    expect((await set(s.ownerCookie, { alertId: id, status: "ack" })).status).toBe(200);
    expect((await set(s.ownerCookie, { alertId: id, status: "resolved", note: "Verified with the cashier" })).status).toBe(200);
    const again = await set(s.ownerCookie, { alertId: id, status: "dismissed" });
    expect(again.status).toBe(400);
    expect(await json(again)).toEqual({ error: "bad_request" });
    const [row] = await admin.sql`select status, resolution_note from app.alerts where id = ${id}`;
    expect(row).toMatchObject({ status: "resolved", resolution_note: "Verified with the cashier" });
  });

  it("checks the shape, the origin and the session", async () => {
    const s = await shop("closeshape");
    const id = await seed(s, "info", "test.note", 1);
    const set = (body: unknown, extra: { origin?: string | null; cookie?: string | null } = {}) =>
      alerts.setStatus(request("POST", "/api/alerts/status", { body, ...(extra.cookie === null ? {} : { cookie: extra.cookie ?? s.ownerCookie }), ...(extra.origin !== undefined ? { origin: extra.origin } : {}) }));
    expect((await set({ alertId: id, status: "new" })).status).toBe(400);
    expect((await set({ alertId: id, status: "maybe" })).status).toBe(400);
    expect((await set({ alertId: "nope", status: "ack" })).status).toBe(400);
    expect((await set({ alertId: id, status: "ack", extra: 1 })).status).toBe(400);
    expect((await set({ alertId: id, status: "dismissed", note: "x".repeat(501) })).status).toBe(400);
    expect((await set({ alertId: id, status: "ack" }, { origin: null })).status).toBe(403);
    expect((await set({ alertId: id, status: "ack" }, { origin: "http://evil.example" })).status).toBe(403);
    expect((await set({ alertId: id, status: "ack" }, { cookie: null })).status).toBe(401);
    expect((await set({ alertId: newUuid(), status: "ack" })).status).toBe(400); // unknown alert
    const [row] = await admin.sql`select status from app.alerts where id = ${id}`;
    expect(row?.status).toBe("new");
  });
});
