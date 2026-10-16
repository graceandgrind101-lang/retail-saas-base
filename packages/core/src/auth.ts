import { isUuid } from "./uuid";

/**
 * Turning a login token's claims into a verified account (Phase A task A7b).
 *
 * The signature, issuer and expiry are checked by the web layer (it needs the crypto library and
 * the key). This is the part that is pure and must never be wrong: WHICH tokens count as a real,
 * signed-in person, and what we take from them. Everything is refused unless proven.
 */

export interface VerifiedAccount {
  authUserId: string;
  /** Lowercase. Only ever taken from a token whose email the identity provider has verified. */
  email: string;
  /** "google", "email", ... as reported by the provider; informational only. */
  provider: string | null;
}

export type TokenProblem =
  | "not_an_object"
  | "wrong_audience"
  | "wrong_role"
  | "anonymous"
  | "bad_subject"
  | "no_email"
  | "email_not_verified";

export class InvalidTokenError extends Error {
  readonly problem: TokenProblem | "bad_signature" | "expired" | "malformed";

  constructor(problem: TokenProblem | "bad_signature" | "expired" | "malformed") {
    // The message is deliberately the same for every problem: callers must not tell the browser why.
    super("The login token is not valid.");
    this.name = "InvalidTokenError";
    this.problem = problem;
  }
}

const EMAIL_SHAPE = /^[^\s@\u0000-\u001f]+@[^\s@\u0000-\u001f]+\.[^\s@\u0000-\u001f]+$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `payload` must come from a token whose signature, issuer and expiry were ALREADY verified.
 * Returns the account, or throws `InvalidTokenError`.
 */
export function accountFromClaims(payload: unknown): VerifiedAccount {
  if (!isRecord(payload)) throw new InvalidTokenError("not_an_object");

  // Supabase tokens are for the "authenticated" audience and role. The public "anon" key is
  // also a signed token, with role "anon": it must never count as a person.
  const audience = payload.aud;
  const audiences = Array.isArray(audience) ? audience : [audience];
  if (!audiences.includes("authenticated")) throw new InvalidTokenError("wrong_audience");
  if (payload.role !== "authenticated") throw new InvalidTokenError("wrong_role");
  if (payload.is_anonymous === true) throw new InvalidTokenError("anonymous");

  const subject = payload.sub;
  if (typeof subject !== "string" || !isUuid(subject)) throw new InvalidTokenError("bad_subject");

  const rawEmail = payload.email;
  if (typeof rawEmail !== "string") throw new InvalidTokenError("no_email");
  const email = rawEmail.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_SHAPE.test(email)) throw new InvalidTokenError("no_email");

  // An invitation is matched on this address, so it must be one the person has proven they own.
  const userMetadata = payload.user_metadata;
  if (!isRecord(userMetadata) || userMetadata.email_verified !== true) {
    throw new InvalidTokenError("email_not_verified");
  }

  const appMetadata = payload.app_metadata;
  const provider = isRecord(appMetadata) && typeof appMetadata.provider === "string" ? appMetadata.provider : null;
  return { authUserId: subject.toLowerCase(), email, provider };
}
