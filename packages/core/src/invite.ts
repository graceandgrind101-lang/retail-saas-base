import { secureRandom, type RandomFill } from "./uuid";

/**
 * Invitation tokens (Phase A task A7). A person is invited to a shop by a link containing a
 * random token. Only the token's SHA-256 is stored, so reading the database never reveals a
 * usable link. The token carries 256 bits of randomness, which is why a plain hash (no pepper,
 * no slow hashing) is enough: there is nothing to guess.
 */

export const INVITE_TOKEN_BYTES = 32;
export const INVITE_VALID_DAYS = 14;

const URL_SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Base64url without padding. Written out by hand because core has no Buffer or btoa. */
export function base64url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const chunk = (a << 16) | (b << 8) | c;
    out += URL_SAFE[(chunk >> 18) & 63];
    out += URL_SAFE[(chunk >> 12) & 63];
    if (i + 1 < bytes.length) out += URL_SAFE[(chunk >> 6) & 63];
    if (i + 2 < bytes.length) out += URL_SAFE[chunk & 63];
  }
  return out;
}

/** 43 URL-safe characters (32 random bytes). */
export function generateInviteToken(random: RandomFill = secureRandom): string {
  return base64url(random(new Uint8Array(INVITE_TOKEN_BYTES)));
}

const WELL_FORMED = /^[A-Za-z0-9_-]{43}$/;

/** A cheap shape check, so obvious junk never reaches the database. */
export function isWellFormedInviteToken(token: string): boolean {
  return WELL_FORMED.test(token);
}

interface SubtleCryptoLike {
  subtle?: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> };
}

/** Lowercase hex SHA-256 of the token: the only form that is stored. */
export async function hashInviteToken(token: string): Promise<string> {
  const subtle = (globalThis as { crypto?: SubtleCryptoLike }).crypto?.subtle;
  if (!subtle) throw new Error("No Web Crypto (crypto.subtle) available to hash the invitation token");
  const bytes = new Uint8Array(token.length);
  for (let i = 0; i < token.length; i++) bytes[i] = token.charCodeAt(i) & 0xff; // tokens are ASCII
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
