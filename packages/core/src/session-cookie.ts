import { base64url, base64urlDecode, utf8Bytes, utf8Text } from "./encoding";
import { isUuid } from "./uuid";

/**
 * The signed cookie that carries a shop sign-in (Phase A task A7b).
 *
 * It holds only three ids (four for a PIN sign-in on a paired device) and an expiry. It proves the browser is presenting a cookie WE issued;
 * it does not prove the sign-in is still alive. That is decided by the database on every request
 * (`private.assert_session_active`), so ending a session works at once no matter what a browser
 * still holds. The signature stops forgery and lets junk be dropped before any database call.
 *
 * Format: base64url(JSON) "." base64url(HMAC-SHA256 over the first part).
 */

export interface SessionCookiePayload {
  tenantId: string;
  staffId: string;
  sessionId: string;
  /** The paired till a PIN sign-in happened on; absent for the admin app. */
  deviceId?: string;
  /** Unix seconds. */
  expiresAt: number;
}

interface SubtleLike {
  importKey(format: "raw", key: Uint8Array, algorithm: { name: string; hash: string }, extractable: boolean, usages: string[]): Promise<unknown>;
  sign(algorithm: string, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  verify(algorithm: string, key: unknown, signature: Uint8Array, data: Uint8Array): Promise<boolean>;
}

function subtle(): SubtleLike {
  const crypto = (globalThis as { crypto?: { subtle?: SubtleLike } }).crypto;
  if (!crypto?.subtle) throw new Error("No Web Crypto (crypto.subtle) available to sign the session cookie");
  return crypto.subtle;
}

const MIN_SECRET_LENGTH = 32;

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<unknown> {
  if (secret.length < MIN_SECRET_LENGTH) throw new Error(`The session secret must be at least ${MIN_SECRET_LENGTH} characters`);
  return subtle().importKey("raw", utf8Bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

export async function signSessionCookie(payload: SessionCookiePayload, secret: string): Promise<string> {
  for (const id of [payload.tenantId, payload.staffId, payload.sessionId, ...(payload.deviceId === undefined ? [] : [payload.deviceId])]) {
    if (!isUuid(id)) throw new TypeError("session cookie ids must be UUIDs");
  }
  if (!Number.isSafeInteger(payload.expiresAt)) throw new TypeError("session cookie expiry must be whole Unix seconds");

  const body = base64url(utf8Bytes(JSON.stringify({ v: 1, t: payload.tenantId, s: payload.staffId, i: payload.sessionId, ...(payload.deviceId === undefined ? {} : { d: payload.deviceId }), e: payload.expiresAt })));
  const signature = new Uint8Array(await subtle().sign("HMAC", await hmacKey(secret, "sign"), utf8Bytes(body)));
  return `${body}.${base64url(signature)}`;
}

/**
 * The payload of a cookie we signed that has not expired, or `null` for ANYTHING else: wrong
 * shape, bad signature (compared in constant time by the platform), tampered body, unknown
 * version, expired, extra fields. Never throws on bad input.
 */
export async function readSessionCookie(value: string, secret: string, nowSeconds: number): Promise<SessionCookiePayload | null> {
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts as [string, string];
  const signatureBytes = base64urlDecode(signature);
  if (!signatureBytes || signatureBytes.length !== 32) return null;

  let valid: boolean;
  try {
    valid = await subtle().verify("HMAC", await hmacKey(secret, "verify"), signatureBytes, utf8Bytes(body));
  } catch {
    return null;
  }
  if (!valid) return null;

  const bodyBytes = base64urlDecode(body);
  const text = bodyBytes ? utf8Text(bodyBytes) : null;
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const claims = parsed as Record<string, unknown>;
  const keys = Object.keys(claims).sort().join(",");
  if ((keys !== "e,i,s,t,v" && keys !== "d,e,i,s,t,v") || claims.v !== 1) return null;
  const { t, s, i, e, d } = claims;
  if (typeof t !== "string" || typeof s !== "string" || typeof i !== "string" || !isUuid(t) || !isUuid(s) || !isUuid(i)) return null;
  if (d !== undefined && (typeof d !== "string" || !isUuid(d))) return null;
  if (typeof e !== "number" || !Number.isSafeInteger(e) || e <= nowSeconds) return null;
  return { tenantId: t, staffId: s, sessionId: i, ...(d === undefined ? {} : { deviceId: d }), expiresAt: e };
}

/** `a=1; b=2` into `{ a: "1", b: "2" }`. Ignores malformed pairs; the first value of a name wins. */
export function parseCookieHeader(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(";")) {
    const index = pair.indexOf("=");
    if (index < 1) continue;
    const name = pair.slice(0, index).trim();
    let value = pair.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    if (name !== "" && !(name in out)) out[name] = value;
  }
  return out;
}
