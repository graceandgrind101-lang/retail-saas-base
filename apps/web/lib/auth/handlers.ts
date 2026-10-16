import { z } from "zod";
import { InvalidTokenError, isUuid, parseCookieHeader, readSessionCookie, signSessionCookie, type VerifiedAccount } from "@retail/core";
import {
  AlreadyMemberError,
  InviteInvalidError,
  NoShopAccessError,
  SessionEndedError,
  acceptInvite,
  endMySession,
  getEnabledModules,
  getMyStaff,
  getMyTenant,
  listMyShops,
  startSession,
  type RlsContext,
  type TenantDb,
} from "@retail/db";
import { clearedSessionCookieHeader, sessionCookieHeader, sessionCookieName } from "./cookie";
import type { TokenVerifier } from "./verify-token";

/**
 * The sign-in endpoints (Phase A task A7b), as plain functions from `Request` to `Response`.
 * The route files are one-line wrappers. Everything they need is passed in, so the tests drive
 * them with real requests against a real database and a token verifier built from a test key.
 *
 * What the browser is ever told: a short, fixed error code. Never a stack, never which check failed.
 * Every state-changing endpoint requires the request to come from this app's own origin.
 */

export interface AuthDeps {
  db: TenantDb;
  verifyToken: TokenVerifier;
  /** Signs the session cookie (SESSION_SECRET). */
  sessionSecret: string;
  /** Where this app is served, e.g. https://app.example.com. */
  appUrl: string;
  /** Milliseconds since the epoch; replaceable in tests. */
  now?: () => number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "HttpError";
  }
}

const MAX_BODY_BYTES = 4096;
const BEARER = /^bearer ([A-Za-z0-9._~+/=-]{1,8192})$/i;

const uuid = z.string().refine(isUuid, "must be a UUID");
const acceptBody = z.object({ token: z.string().length(43) }).strict();
const sessionBody = z.object({ tenantId: uuid }).strict();

export function createAuthHandlers(deps: AuthDeps) {
  const now = deps.now ?? Date.now;
  const origin = new URL(deps.appUrl).origin;
  const clearCookie = { "set-cookie": clearedSessionCookieHeader(deps.appUrl) };

  const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
    });

  /** Requests that change anything must come from our own pages: a form on another site cannot send this. */
  function requireSameOrigin(request: Request): void {
    if (request.headers.get("origin") !== origin) throw new HttpError(403, "bad_origin");
  }

  async function verifiedAccount(request: Request): Promise<VerifiedAccount> {
    const match = BEARER.exec(request.headers.get("authorization") ?? "");
    if (!match?.[1]) throw new InvalidTokenError("malformed");
    return deps.verifyToken(match[1]);
  }

  async function readBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) throw new HttpError(400, "bad_request");
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) throw new HttpError(400, "bad_request");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new HttpError(400, "bad_request");
    }
    const result = schema.safeParse(parsed);
    if (!result.success) throw new HttpError(400, "bad_request");
    return result.data;
  }

  /** The shop sign-in named by the signed cookie, or null. The DATABASE still decides if it is alive. */
  async function sessionContext(request: Request): Promise<RlsContext | null> {
    const value = parseCookieHeader(request.headers.get("cookie"))[sessionCookieName(deps.appUrl)];
    if (!value) return null;
    const payload = await readSessionCookie(value, deps.sessionSecret, Math.floor(now() / 1000));
    return payload ? { tenantId: payload.tenantId, staffId: payload.staffId, sessionId: payload.sessionId } : null;
  }

  function errorResponse(error: unknown): Response {
    if (error instanceof HttpError) return json(error.status, { error: error.code });
    if (error instanceof InvalidTokenError) return json(401, { error: "unauthenticated" });
    if (error instanceof SessionEndedError) return json(401, { error: "session_ended" }, clearCookie);
    if (error instanceof NoShopAccessError) return json(403, { error: "no_access" });
    if (error instanceof InviteInvalidError) return json(400, { error: "invite_invalid" });
    if (error instanceof AlreadyMemberError) return json(409, { error: "already_member" });
    // Log the kind of failure only: messages can carry data.
    console.error("auth endpoint failed:", error instanceof Error ? error.name : "unknown error");
    return json(500, { error: "server_error" });
  }

  const guard = (fn: () => Promise<Response>): Promise<Response> => fn().catch(errorResponse);

  return {
    /** POST: the shops the signed-in account belongs to (the shop picker). Needs a login token. */
    shops: (request: Request) =>
      guard(async () => {
        requireSameOrigin(request);
        const account = await verifiedAccount(request);
        const shops = await deps.db.identity({ authUserId: account.authUserId, email: account.email }, (tx) => listMyShops(tx));
        return json(200, {
          shops: shops.map((s) => ({ tenantId: s.tenantId, slug: s.slug, name: s.displayName, status: s.tenantStatus, role: s.roleKey, staffName: s.staffName })),
        });
      }),

    /** POST { token }: follow an invitation link. Needs a login token whose verified email matches the invitation. */
    acceptInvite: (request: Request) =>
      guard(async () => {
        requireSameOrigin(request);
        const account = await verifiedAccount(request);
        const { token } = await readBody(request, acceptBody);
        const accepted = await deps.db.identity({ authUserId: account.authUserId, email: account.email }, (tx) => acceptInvite(tx, token));
        return json(200, accepted);
      }),

    /** POST { tenantId }: sign in to one shop. Sets the session cookie. Needs a login token. */
    startSession: (request: Request) =>
      guard(async () => {
        requireSameOrigin(request);
        const account = await verifiedAccount(request);
        const { tenantId } = await readBody(request, sessionBody);
        const method = account.provider === "google" ? "google" : "password";
        const started = await deps.db.identity({ authUserId: account.authUserId, email: account.email }, (tx) =>
          startSession(tx, { tenantId, method }),
        );
        const expiresAtSeconds = Math.floor(started.expiresAt.getTime() / 1000);
        const cookie = await signSessionCookie(
          { tenantId: started.tenantId, staffId: started.staffId, sessionId: started.sessionId, expiresAt: expiresAtSeconds },
          deps.sessionSecret,
        );
        return json(
          200,
          { tenantId: started.tenantId, expiresAt: started.expiresAt.toISOString() },
          { "set-cookie": sessionCookieHeader(deps.appUrl, cookie, expiresAtSeconds - now() / 1000) },
        );
      }),

    /** POST: end THIS sign-in. Always forgets the cookie, even if the session was already over. */
    signOut: (request: Request) =>
      guard(async () => {
        requireSameOrigin(request);
        const context = await sessionContext(request);
        if (context) {
          try {
            await deps.db.rls(context, (tx) => endMySession(tx));
          } catch (error) {
            if (!(error instanceof SessionEndedError)) throw error;
          }
        }
        return json(200, { signedOut: true }, clearCookie);
      }),

    /** GET: who am I, in which shop, with which modules. Needs the session cookie. */
    me: (request: Request) =>
      guard(async () => {
        const context = await sessionContext(request);
        if (!context) {
          const hadCookie = Boolean(parseCookieHeader(request.headers.get("cookie"))[sessionCookieName(deps.appUrl)]);
          return json(401, { error: "unauthenticated" }, hadCookie ? clearCookie : {});
        }
        const { staff, tenant, modules } = await deps.db.rls(context, async (tx) => ({
          staff: await getMyStaff(tx),
          tenant: await getMyTenant(tx),
          modules: await getEnabledModules(tx),
        }));
        if (!staff || !tenant) throw new SessionEndedError();
        return json(200, {
          staff: { id: staff.staffId, name: staff.name, role: staff.roleKey, language: staff.language, calendar: staff.calendar, theme: staff.theme },
          tenant: { id: tenant.id, slug: tenant.slug, name: tenant.displayName, status: tenant.status, industry: tenant.industry, timezone: tenant.timezone, currency: tenant.currency },
          modules,
        });
      }),
  };
}

export type AuthHandlers = ReturnType<typeof createAuthHandlers>;
