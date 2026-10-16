import { SignJWT } from "jose";

/** A token-signing secret for tests only. Not a real secret. */
export const TEST_JWT_SECRET = "Pj4nXk8wQs2vLb7yTe1uMh6dCz9rAo3f";
export const TEST_SUPABASE_URL = "http://127.0.0.1:54321";
export const TEST_ISSUER = `${TEST_SUPABASE_URL}/auth/v1`;

export interface TokenOptions {
  /** The account's id (the token's `sub`). */
  sub: string;
  email: string;
  provider?: string;
  /** Default true. */
  emailVerified?: boolean;
  /** Seconds from now; negative makes an already-expired token. Default one hour. */
  expiresIn?: number;
  audience?: string | string[];
  role?: string;
  issuer?: string;
  /** Extra or overriding claims. */
  claims?: Record<string, unknown>;
  secret?: string;
  alg?: "HS256" | "HS384" | "HS512";
}

/** A token shaped like the ones the login service issues for a signed-in, email-verified person. */
export async function mintToken(options: TokenOptions): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    role: options.role ?? "authenticated",
    email: options.email,
    app_metadata: { provider: options.provider ?? "email", providers: [options.provider ?? "email"] },
    user_metadata: { email_verified: options.emailVerified ?? true },
    ...options.claims,
  })
    .setProtectedHeader({ alg: options.alg ?? "HS256", typ: "JWT" })
    .setIssuer(options.issuer ?? TEST_ISSUER)
    .setAudience(options.audience ?? "authenticated")
    .setSubject(options.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + (options.expiresIn ?? 3600))
    .sign(new TextEncoder().encode(options.secret ?? TEST_JWT_SECRET));
}

const b64 = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

/** An UNSIGNED token ("alg: none"): the classic forgery. */
export function unsignedToken(payload: Record<string, unknown>): string {
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.`;
}
