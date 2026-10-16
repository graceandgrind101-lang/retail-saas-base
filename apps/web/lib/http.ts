import type { z } from "zod";
import { parseCookieHeader, readSessionCookie } from "@retail/core";
import type { RlsContext } from "@retail/db";
import { sessionCookieName } from "./auth/cookie";

/**
 * Small request/response helpers shared by every API route (Phase A tasks A7b and A8).
 * What the browser is ever told: a short, fixed error code. Never a stack, never which check failed.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "HttpError";
  }
}

export const MAX_BODY_BYTES = 4096;

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

/** Requests that change anything must come from our own pages: a form on another site cannot send this. */
export function requireSameOrigin(request: Request, appUrl: string): void {
  if (request.headers.get("origin") !== new URL(appUrl).origin) throw new HttpError(403, "bad_origin");
}

export async function readJsonBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
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
export async function readSessionContext(
  request: Request,
  options: { appUrl: string; sessionSecret: string; nowSeconds: number },
): Promise<RlsContext | null> {
  const value = parseCookieHeader(request.headers.get("cookie"))[sessionCookieName(options.appUrl)];
  if (!value) return null;
  const payload = await readSessionCookie(value, options.sessionSecret, options.nowSeconds);
  if (!payload) return null;
  return {
    tenantId: payload.tenantId,
    staffId: payload.staffId,
    sessionId: payload.sessionId,
    ...(payload.deviceId ? { deviceId: payload.deviceId } : {}),
  };
}
