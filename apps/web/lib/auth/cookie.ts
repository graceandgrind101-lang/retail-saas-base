/**
 * The session cookie's name and attributes (Phase A task A7b).
 *
 *  - HttpOnly: page scripts can never read it, so a script injected into a page cannot steal a sign-in.
 *  - Secure when the app is served over https. The `__Host-` prefix (https only) additionally makes
 *    the browser refuse to accept it from a sibling subdomain or with a Domain attribute.
 *  - SameSite=Lax: not sent on cross-site POSTs. State-changing requests also check the Origin
 *    header (origin.ts), so a forged form on another site cannot act as a signed-in person.
 *  - Path=/ and no Domain: only this exact host gets it.
 */

const SESSION_COOKIE = "retail_session";

export const isHttps = (appUrl: string): boolean => new URL(appUrl).protocol === "https:";

export function sessionCookieName(appUrl: string): string {
  return isHttps(appUrl) ? `__Host-${SESSION_COOKIE}` : SESSION_COOKIE;
}

export function sessionCookieHeader(appUrl: string, value: string, maxAgeSeconds: number): string {
  const parts = [`${sessionCookieName(appUrl)}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`];
  if (isHttps(appUrl)) parts.push("Secure");
  return parts.join("; ");
}

/** A header that makes the browser forget the cookie now. */
export function clearedSessionCookieHeader(appUrl: string): string {
  const parts = [`${sessionCookieName(appUrl)}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT"];
  if (isHttps(appUrl)) parts.push("Secure");
  return parts.join("; ");
}
