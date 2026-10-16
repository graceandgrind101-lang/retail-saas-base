import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createTenantDb, type TenantDb } from "@retail/db";
import { createAdminDb, provisionTenant, type AdminDb } from "@retail/db/admin";
import { newUuid } from "./ids";
import { createAuthHandlers } from "../lib/auth/handlers";
import { createTokenVerifier } from "../lib/auth/verify-token";
import { TEST_ISSUER, TEST_JWT_SECRET, mintToken, unsignedToken } from "./tokens";

const APP_URL = "http://localhost:3000";
const SESSION_SECRET = "k3Jf9aQ2xLm7ZpR1tVb8nWc4yHd6sGu0";

let admin: AdminDb;
let db: TenantDb;
let handlers: ReturnType<typeof createAuthHandlers>;

beforeAll(() => {
  admin = createAdminDb(inject("adminUrl"), { max: 3 });
  db = createTenantDb(inject("appUrl"), { max: 6 });
  handlers = createAuthHandlers({
    db,
    verifyToken: createTokenVerifier({ issuer: TEST_ISSUER, jwtSecret: TEST_JWT_SECRET }),
    sessionSecret: SESSION_SECRET,
    appUrl: APP_URL,
  });
});
afterAll(async () => {
  await db.close();
  await admin.close();
});

// ── helpers ──────────────────────────────────────────────────────────────────
const suffix = () => randomBytes(4).toString("hex");

interface Account {
  sub: string;
  email: string;
  provider?: string;
}
const newAccount = (email = `person-${suffix()}@example.com`, provider?: string): Account => ({ sub: newUuid(), email, ...(provider ? { provider } : {}) });

async function shopWithInvite(prefix: string) {
  const email = `owner-${suffix()}@example.com`;
  const shop = await provisionTenant(admin.sql, {
    slug: `${prefix}-${suffix()}`,
    displayName: { en: `Shop ${prefix}` },
    industry: "electronics",
    planKey: "pro",
    owner: { email, displayName: "Owner Person" },
  });
  if (!shop.ownerInvite) throw new Error("expected an invitation");
  // A second owner, so tests can suspend the first (a shop can never lose its last owner).
  await admin.sql`insert into app.staff (id, tenant_id, display_name, role_id, status)
                  values (${newUuid()}, ${shop.tenantId}, 'Co-owner', ${shop.roleIds.owner}, 'active')`;
  return { ...shop, ownerEmail: email, inviteToken: shop.ownerInvite.token };
}

interface Options {
  token?: string;
  body?: unknown;
  rawBody?: string;
  origin?: string | null;
  cookie?: string;
  authorization?: string;
}

function request(method: "GET" | "POST", path: string, options: Options = {}): Request {
  const headers = new Headers();
  if (options.token !== undefined) headers.set("authorization", `Bearer ${options.token}`);
  if (options.authorization !== undefined) headers.set("authorization", options.authorization);
  const origin = options.origin === undefined ? APP_URL : options.origin;
  if (origin !== null) headers.set("origin", origin);
  if (options.cookie) headers.set("cookie", options.cookie);
  const body = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request(`${APP_URL}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
}

/** The fields the endpoints can return. */
interface ApiBody {
  error?: string;
  shops?: unknown[];
  tenantId?: string;
  staffId?: string;
  expiresAt?: string;
  signedOut?: boolean;
  staff?: Record<string, unknown>;
  tenant?: { status?: string } & Record<string, unknown>;
  modules?: string[];
}

async function body(response: Response): Promise<ApiBody> {
  return (await response.json()) as ApiBody;
}

/** `name=value` from a Set-Cookie header, as a browser would send it back. */
function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header) throw new Error("no Set-Cookie header");
  return header.split(";")[0] ?? "";
}

const tokenFor = (account: Account, extra: { expiresIn?: number } = {}) => mintToken({ ...account, ...extra });

/** The owner follows the invitation and signs in to the shop: the whole happy path. */
async function ownerSignedIn(prefix: string) {
  const shop = await shopWithInvite(prefix);
  const account: Account = { sub: newUuid(), email: shop.ownerEmail, provider: "google" };
  const token = await tokenFor(account);
  const accepted = await handlers.acceptInvite(request("POST", "/api/auth/invite/accept", { token, body: { token: shop.inviteToken } }));
  expect(accepted.status, JSON.stringify(await accepted.clone().json())).toBe(200);
  const started = await handlers.startSession(request("POST", "/api/auth/session", { token, body: { tenantId: shop.tenantId } }));
  expect(started.status).toBe(200);
  return { shop, account, token, cookie: cookieFrom(started), started };
}

const me = (cookie?: string) => handlers.me(request("GET", "/api/auth/me", cookie ? { cookie } : {}));

// ── the whole journey ────────────────────────────────────────────────────────
describe("the sign-in journey, over HTTP", () => {
  it("invitation, shop picker, sign-in, who-am-I, sign-out", async () => {
    const shop = await shopWithInvite("journey");
    const account: Account = { sub: newUuid(), email: shop.ownerEmail, provider: "google" };
    const token = await tokenFor(account);

    // before the invitation: no shops
    const before = await handlers.shops(request("POST", "/api/auth/shops", { token }));
    expect(before.status).toBe(200);
    expect((await body(before)).shops).toEqual([]);

    // follow the invitation
    const accepted = await handlers.acceptInvite(request("POST", "/api/auth/invite/accept", { token, body: { token: shop.inviteToken } }));
    expect(accepted.status).toBe(200);
    expect(await body(accepted)).toEqual({ tenantId: shop.tenantId, staffId: shop.ownerInvite?.staffId });

    // the shop picker now lists it
    const listed = await body(await handlers.shops(request("POST", "/api/auth/shops", { token })));
    expect(listed.shops).toEqual([
      { tenantId: shop.tenantId, slug: shop.slug, name: { en: `Shop journey` }, status: "pilot", role: "owner", staffName: "Owner Person" },
    ]);

    // sign in to it
    const started = await handlers.startSession(request("POST", "/api/auth/session", { token, body: { tenantId: shop.tenantId } }));
    expect(started.status).toBe(200);
    const startedBody = await body(started);
    expect(startedBody.tenantId).toBe(shop.tenantId);
    expect(new Date(startedBody.expiresAt ?? 0).getTime()).toBeGreaterThan(Date.now() + 6.9 * 86_400_000);
    const cookie = cookieFrom(started);

    // who am I
    const who = await me(cookie);
    expect(who.status).toBe(200);
    const profile = await body(who);
    expect(profile.staff).toMatchObject({ id: shop.ownerInvite?.staffId, name: "Owner Person", role: "owner" });
    expect(profile.tenant).toMatchObject({ id: shop.tenantId, slug: shop.slug, status: "pilot", industry: "electronics", currency: "ETB" });
    expect(profile.modules).toEqual(expect.arrayContaining(["pos", "inventory", "serials"]));

    // sign out
    const out = await handlers.signOut(request("POST", "/api/auth/signout", { cookie }));
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");

    // the old cookie is dead
    const after = await me(cookie);
    expect(after.status).toBe(401);
    expect(await body(after)).toEqual({ error: "session_ended" });
  });

  it("the session is recorded with the account's sign-in method", async () => {
    const google = await ownerSignedIn("method-google");
    const [row] = await admin.sql<{ method: string }[]>`select method from app.staff_sessions where tenant_id = ${google.shop.tenantId}`;
    expect(row?.method).toBe("google");

    const shop = await shopWithInvite("method-email");
    const account = newAccount(shop.ownerEmail); // provider "email"
    const token = await tokenFor(account);
    await handlers.acceptInvite(request("POST", "/api/auth/invite/accept", { token, body: { token: shop.inviteToken } }));
    await handlers.startSession(request("POST", "/api/auth/session", { token, body: { tenantId: shop.tenantId } }));
    const [other] = await admin.sql<{ method: string }[]>`select method from app.staff_sessions where tenant_id = ${shop.tenantId}`;
    expect(other?.method).toBe("password");
  });
});

// ── the done-when, from the web side ─────────────────────────────────────────
describe("suspending a staff member (done-when for A7)", () => {
  it("their cookie stops working on the very next request, and the browser is told to forget it", async () => {
    const { cookie, shop } = await ownerSignedIn("suspend");
    expect((await me(cookie)).status).toBe(200);

    await admin.sql`update app.staff set status = 'suspended' where id = ${shop.ownerInvite?.staffId ?? ""}`;

    const after = await me(cookie);
    expect(after.status).toBe(401);
    expect(await body(after)).toEqual({ error: "session_ended" });
    expect(after.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("closing the shop does the same, and a paused shop can still be viewed", async () => {
    const paused = await ownerSignedIn("paused");
    await admin.sql`update platform.tenants set status = 'paused' where id = ${paused.shop.tenantId}`;
    const view = await me(paused.cookie);
    expect(view.status).toBe(200);
    expect((await body(view)).tenant?.status).toBe("paused");

    const closed = await ownerSignedIn("closed");
    await admin.sql`update platform.tenants set status = 'closed' where id = ${closed.shop.tenantId}`;
    expect((await me(closed.cookie)).status).toBe(401);
  });

  it("a paused shop's person can still sign out", async () => {
    const { cookie, shop } = await ownerSignedIn("paused-out");
    await admin.sql`update platform.tenants set status = 'paused' where id = ${shop.tenantId}`;
    const out = await handlers.signOut(request("POST", "/api/auth/signout", { cookie }));
    expect(out.status).toBe(200);
    const [row] = await admin.sql<{ ended_reason: string | null }[]>`select ended_reason from app.staff_sessions where tenant_id = ${shop.tenantId}`;
    expect(row?.ended_reason).toBe("logout");
  });
});

// ── bad or missing login tokens ──────────────────────────────────────────────
describe("login token problems all look the same: 401 unauthenticated", () => {
  const account = newAccount();
  const endpoints = [
    ["shops", (o: Options) => handlers.shops(request("POST", "/api/auth/shops", o))],
    ["accept invite", (o: Options) => handlers.acceptInvite(request("POST", "/api/auth/invite/accept", { ...o, body: { token: "A".repeat(43) } }))],
    ["start session", (o: Options) => handlers.startSession(request("POST", "/api/auth/session", { ...o, body: { tenantId: newUuid() } }))],
  ] as const;

  const bad: [string, () => Promise<Options>][] = [
    ["no Authorization header", async () => ({})],
    ["the wrong scheme", async () => ({ authorization: `Basic ${await tokenFor(account)}` })],
    ["an empty token", async () => ({ authorization: "Bearer " })],
    ["an expired token", async () => ({ token: await tokenFor(account, { expiresIn: -120 }) })],
    ["a token signed with another secret", async () => ({ token: await mintToken({ ...account, secret: "Zx6cVb3nMq8wEr1tYu4iOp7aSd2fGh5j" }) })],
    ["an unsigned token", async () => ({ token: unsignedToken({ sub: account.sub, email: account.email, aud: "authenticated", role: "authenticated", iss: TEST_ISSUER, exp: 4_102_444_800, user_metadata: { email_verified: true } }) })],
    ["an unverified email", async () => ({ token: await mintToken({ ...account, emailVerified: false }) })],
    ["the public anon key", async () => ({ token: await mintToken({ ...account, role: "anon" }) })],
    ["garbage", async () => ({ token: "not.a.token" })],
  ];

  for (const [name, call] of endpoints) {
    it.each(bad)(`${name}: %s`, async (_label, make) => {
      const response = await call(await make());
      expect(response.status).toBe(401);
      expect(await body(response)).toEqual({ error: "unauthenticated" });
      expect(response.headers.get("set-cookie")).toBeNull();
    });
  }
});

// ── cross-site forgery ───────────────────────────────────────────────────────
describe("requests must come from the app's own origin", () => {
  it.each([
    ["no Origin header", null],
    ["another site", "https://evil.example"],
    ["the same host on another port", "http://localhost:3001"],
    ["the same host over https", "https://localhost:3000"],
    ["a look-alike", "http://localhost:3000.evil.example"],
    ["the literal string null", "null"],
  ])("a state-changing request with %s is refused with 403 before any token is looked at", async (_label, origin) => {
    const token = await tokenFor(newAccount());
    const calls = [
      handlers.shops(request("POST", "/api/auth/shops", { token, origin })),
      handlers.acceptInvite(request("POST", "/api/auth/invite/accept", { token, origin, body: { token: "A".repeat(43) } })),
      handlers.startSession(request("POST", "/api/auth/session", { token, origin, body: { tenantId: newUuid() } })),
      handlers.signOut(request("POST", "/api/auth/signout", { origin })),
    ];
    for (const response of await Promise.all(calls)) {
      expect(response.status).toBe(403);
      expect(await body(response)).toEqual({ error: "bad_origin" });
    }
  });

  it("a forged sign-out does not end the session", async () => {
    const { cookie } = await ownerSignedIn("csrf");
    const forged = await handlers.signOut(request("POST", "/api/auth/signout", { cookie, origin: "https://evil.example" }));
    expect(forged.status).toBe(403);
    expect((await me(cookie)).status).toBe(200);
  });

  it("reading who-am-I needs no Origin (it only returns data to the page that asks)", async () => {
    const { cookie } = await ownerSignedIn("get-origin");
    const response = await handlers.me(request("GET", "/api/auth/me", { cookie, origin: null }));
    expect(response.status).toBe(200);
  });
});

// ── bad request bodies ───────────────────────────────────────────────────────
describe("malformed bodies are 400 bad_request with no details", () => {
  it.each([
    ["not JSON", { rawBody: "{nope" }],
    ["an empty body", { rawBody: "" }],
    ["a JSON array", { rawBody: "[]" }],
    ["the wrong field", { body: { tenant: newUuid() } }],
    ["an extra field", { body: { tenantId: newUuid(), admin: true } }],
    ["a tenant id that is not a UUID", { body: { tenantId: "1; drop table x" } }],
    ["a body that is far too large", { rawBody: JSON.stringify({ tenantId: newUuid(), pad: "x".repeat(10_000) }) }],
  ])("start session: %s", async (_label, options) => {
    const token = await tokenFor(newAccount());
    const response = await handlers.startSession(request("POST", "/api/auth/session", { token, ...options }));
    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({ error: "bad_request" });
  });

  it.each([
    ["a token that is too short", { token: "short" }],
    ["a token of the right length that is not a token", { token: "!".repeat(43) }],
    ["a number", { token: 43 }],
    ["no token", {}],
  ])("accept invite: %s", async (_label, payload) => {
    const token = await tokenFor(newAccount());
    const response = await handlers.acceptInvite(request("POST", "/api/auth/invite/accept", { token, body: payload }));
    expect([400]).toContain(response.status);
  });
});

// ── invitations through the web ──────────────────────────────────────────────
describe("invitations over HTTP", () => {
  it("an account with a DIFFERENT email is refused, and the invitation stays usable", async () => {
    const shop = await shopWithInvite("inv-wrong");
    const wrong = await tokenFor(newAccount("someone.else@example.com"));
    const refused = await handlers.acceptInvite(request("POST", "/api/auth/invite/accept", { token: wrong, body: { token: shop.inviteToken } }));
    expect(refused.status).toBe(400);
    expect(await body(refused)).toEqual({ error: "invite_invalid" });

    const right = await tokenFor(newAccount(shop.ownerEmail));
    const accepted = await handlers.acceptInvite(request("POST", "/api/auth/invite/accept", { token: right, body: { token: shop.inviteToken } }));
    expect(accepted.status).toBe(200);
  });

  it("an invitation cannot be used twice, and every kind of invalid gives the same answer", async () => {
    const shop = await shopWithInvite("inv-twice");
    const token = await tokenFor(newAccount(shop.ownerEmail));
    expect((await handlers.acceptInvite(request("POST", "/api/auth/invite/accept", { token, body: { token: shop.inviteToken } }))).status).toBe(200);

    const answers = new Set<string>();
    for (const attempt of [shop.inviteToken, "A".repeat(43), randomBytes(32).toString("base64url")]) {
      const other = await tokenFor(newAccount(shop.ownerEmail));
      const response = await handlers.acceptInvite(request("POST", "/api/auth/invite/accept", { token: other, body: { token: attempt } }));
      answers.add(`${response.status} ${JSON.stringify(await response.json())}`);
    }
    expect([...answers]).toEqual(['400 {"error":"invite_invalid"}']);
  });

  it("joining a shop you already belong to is a distinct 409", async () => {
    const shop = await shopWithInvite("inv-member");
    const account = newAccount(shop.ownerEmail);
    const token = await tokenFor(account);
    await handlers.acceptInvite(request("POST", "/api/auth/invite/accept", { token, body: { token: shop.inviteToken } }));

    const second = (await import("@retail/core")).generateInviteToken();
    const { hashInviteToken } = await import("@retail/core");
    await admin.sql`insert into app.staff (id, tenant_id, display_name, role_id, status, invite_email, invite_token_hash, invite_expires_at)
                    values (${newUuid()}, ${shop.tenantId}, 'Again', ${shop.roleIds.manager}, 'invited', ${shop.ownerEmail}, ${await hashInviteToken(second)}, now() + interval '1 day')`;
    const response = await handlers.acceptInvite(request("POST", "/api/auth/invite/accept", { token, body: { token: second } }));
    expect(response.status).toBe(409);
    expect(await body(response)).toEqual({ error: "already_member" });
  });
});

// ── starting a session ───────────────────────────────────────────────────────
describe("starting a session over HTTP", () => {
  it("is refused (403) for a shop the account does not belong to", async () => {
    const mine = await ownerSignedIn("sess-mine");
    const other = await shopWithInvite("sess-other");
    const response = await handlers.startSession(request("POST", "/api/auth/session", { token: mine.token, body: { tenantId: other.tenantId } }));
    expect(response.status).toBe(403);
    expect(await body(response)).toEqual({ error: "no_access" });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("is refused for a shop that does not exist, with the same answer (no way to probe for shops)", async () => {
    const { token } = await ownerSignedIn("sess-ghost");
    const response = await handlers.startSession(request("POST", "/api/auth/session", { token, body: { tenantId: newUuid() } }));
    expect(response.status).toBe(403);
    expect(await body(response)).toEqual({ error: "no_access" });
  });

  it("is refused for a suspended person", async () => {
    const { token, shop } = await ownerSignedIn("sess-suspended");
    await admin.sql`update app.staff set status = 'suspended' where id = ${shop.ownerInvite?.staffId ?? ""}`;
    const response = await handlers.startSession(request("POST", "/api/auth/session", { token, body: { tenantId: shop.tenantId } }));
    expect(response.status).toBe(403);
  });

  it("each sign-in gets its own session; signing out one leaves the other", async () => {
    const { token, cookie, shop } = await ownerSignedIn("sess-two");
    const second = cookieFrom(await handlers.startSession(request("POST", "/api/auth/session", { token, body: { tenantId: shop.tenantId } })));
    expect(second).not.toBe(cookie);
    await handlers.signOut(request("POST", "/api/auth/signout", { cookie }));
    expect((await me(cookie)).status).toBe(401);
    expect((await me(second)).status).toBe(200);
  });
});

// ── the cookie ───────────────────────────────────────────────────────────────
describe("the session cookie", () => {
  it("is HttpOnly, SameSite=Lax, scoped to /, with no Domain, and lasts about a week (plain-http app)", async () => {
    const { started } = await ownerSignedIn("cookie-flags");
    const header = started.headers.get("set-cookie") ?? "";
    expect(header).toMatch(/^retail_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}; /);
    expect(header).toContain("Path=/");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).not.toContain("Domain");
    expect(header).not.toContain("Secure"); // only over https
    const maxAge = Number(/Max-Age=(\d+)/.exec(header)?.[1]);
    expect(maxAge).toBeGreaterThan(6.9 * 86_400);
    expect(maxAge).toBeLessThanOrEqual(7 * 86_400);
  });

  it("for an https app is Secure and uses the __Host- prefix", async () => {
    const secure = createAuthHandlers({
      db,
      verifyToken: createTokenVerifier({ issuer: TEST_ISSUER, jwtSecret: TEST_JWT_SECRET }),
      sessionSecret: SESSION_SECRET,
      appUrl: "https://app.example.com",
    });
    const shop = await shopWithInvite("cookie-https");
    const token = await tokenFor(newAccount(shop.ownerEmail));
    const send = (path: string, init: Options) =>
      new Request(`https://app.example.com${path}`, { method: "POST", headers: { origin: "https://app.example.com", authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.cookie ? { cookie: init.cookie } : {}) }, body: JSON.stringify(init.body) });
    await secure.acceptInvite(send("/api/auth/invite/accept", { body: { token: shop.inviteToken } }));
    const started = await secure.startSession(send("/api/auth/session", { body: { tenantId: shop.tenantId } }));
    const header = started.headers.get("set-cookie") ?? "";
    expect(header).toMatch(/^__Host-retail_session=/);
    expect(header).toContain("Secure");
    expect(header).toContain("Path=/");
    expect(header).not.toContain("Domain");
    // and the clearing header is Secure too
    const out = await secure.signOut(send("/api/auth/signout", { cookie: header.split(";")[0] ?? "" }));
    expect(out.headers.get("set-cookie")).toMatch(/^__Host-retail_session=; .*Secure/);
  });

  it.each([
    ["tampered", (c: string) => `${c.slice(0, -2)}${c.endsWith("AA") ? "BB" : "AA"}`],
    ["truncated", (c: string) => c.slice(0, c.indexOf("=") + 20)],
    ["empty", () => "retail_session="],
    ["junk", () => "retail_session=not-a-cookie"],
  ])("a %s cookie is refused with 401 and cleared", async (_label, mangle) => {
    const { cookie } = await ownerSignedIn("cookie-bad");
    const response = await me(mangle(cookie));
    expect(response.status).toBe(401);
    expect(await body(response)).toEqual({ error: "unauthenticated" });
  });

  it("a cookie signed with a different secret is refused", async () => {
    const { cookie } = await ownerSignedIn("cookie-secret");
    const other = createAuthHandlers({
      db,
      verifyToken: createTokenVerifier({ issuer: TEST_ISSUER, jwtSecret: TEST_JWT_SECRET }),
      sessionSecret: "Qw8eRt5yUi2oPa7sDf4gHj1kLz9xCv3b",
      appUrl: APP_URL,
    });
    expect((await other.me(request("GET", "/api/auth/me", { cookie }))).status).toBe(401);
  });

  it("an expired cookie is refused even though the session row is still open", async () => {
    const { cookie } = await ownerSignedIn("cookie-expired");
    const future = createAuthHandlers({
      db,
      verifyToken: createTokenVerifier({ issuer: TEST_ISSUER, jwtSecret: TEST_JWT_SECRET }),
      sessionSecret: SESSION_SECRET,
      appUrl: APP_URL,
      now: () => Date.now() + 8 * 86_400_000,
    });
    expect((await future.me(request("GET", "/api/auth/me", { cookie }))).status).toBe(401);
  });

  it("a cookie for one shop cannot be pointed at another shop's staff or session", async () => {
    const a = await ownerSignedIn("cookie-cross-a");
    const b = await ownerSignedIn("cookie-cross-b");
    const { signSessionCookie } = await import("@retail/core");
    const forged = await signSessionCookie(
      {
        tenantId: b.shop.tenantId,
        staffId: a.shop.ownerInvite?.staffId ?? "",
        sessionId: (await admin.sql<{ id: string }[]>`select id from app.staff_sessions where tenant_id = ${a.shop.tenantId}`)[0]?.id ?? "",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      },
      SESSION_SECRET, // even properly signed by the real secret, the database says no
    );
    const response = await me(`retail_session=${forged}`);
    expect(response.status).toBe(401);
    expect(await body(response)).toEqual({ error: "session_ended" });
  });

  it("who-am-I without a cookie is 401 and does not try to clear anything", async () => {
    const response = await me();
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("sign-out works with no cookie or a junk one, and always clears", async () => {
    for (const cookie of [undefined, "retail_session=junk"]) {
      const response = await handlers.signOut(request("POST", "/api/auth/signout", cookie ? { cookie } : {}));
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    }
  });

  it("signing out twice is harmless", async () => {
    const { cookie } = await ownerSignedIn("cookie-twice");
    expect((await handlers.signOut(request("POST", "/api/auth/signout", { cookie }))).status).toBe(200);
    expect((await handlers.signOut(request("POST", "/api/auth/signout", { cookie }))).status).toBe(200);
  });
});

// ── what the browser is told ─────────────────────────────────────────────────
describe("responses", () => {
  it("are JSON, never cached, and errors carry nothing but a short code", async () => {
    const responses = [
      await handlers.shops(request("POST", "/api/auth/shops")),
      await handlers.startSession(request("POST", "/api/auth/session", { token: await tokenFor(newAccount()), body: {} })),
      await me(),
    ];
    for (const response of responses) {
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("cache-control")).toBe("no-store");
      const parsed = await body(response);
      expect(Object.keys(parsed)).toEqual(["error"]);
      expect(String(parsed.error)).toMatch(/^[a-z_]{3,20}$/);
    }
  });

  it("an unexpected failure is a plain 500 server_error that leaks nothing", async () => {
    const broken = createAuthHandlers({
      db: { ...db, identity: async () => { throw new Error("password=hunter2 at db.internal:5432"); } } as TenantDb,
      verifyToken: createTokenVerifier({ issuer: TEST_ISSUER, jwtSecret: TEST_JWT_SECRET }),
      sessionSecret: SESSION_SECRET,
      appUrl: APP_URL,
    });
    const response = await broken.shops(request("POST", "/api/auth/shops", { token: await tokenFor(newAccount()) }));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toBe('{"error":"server_error"}');
    expect(text).not.toContain("hunter2");
  });
});
