import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload } from "jose";
import { InvalidTokenError, accountFromClaims, type ServerEnv, type VerifiedAccount } from "@retail/core";

/**
 * Checking a Supabase login token (Phase A task A7b).
 *
 * This file does the cryptography (signature, issuer, expiry, which algorithms are allowed);
 * which claims make someone a real, verified person is decided by the pure `accountFromClaims`
 * in @retail/core. Every failure is the same `InvalidTokenError` so the browser is never told why.
 */

export type TokenVerifier = (token: string) => Promise<VerifiedAccount>;

export interface TokenVerifierOptions {
  /** The `iss` the project puts in its tokens: `<project url>/auth/v1`. */
  issuer: string;
  /**
   * The project's shared signing secret (HS256: local Supabase, older cloud projects). When this
   * is set ONLY HS256 is accepted. Leave out for asymmetric projects and give `jwksUrl` instead.
   */
  jwtSecret?: string;
  /** Where the project publishes its public keys. Used when there is no `jwtSecret`; only asymmetric algorithms are accepted then. */
  jwksUrl?: string;
}

/** A token far larger than any real one is refused before any work is done on it. */
const MAX_TOKEN_LENGTH = 8192;
/** Seconds of clock difference tolerated between this server and the login service. */
const CLOCK_TOLERANCE_SECONDS = 5;
const AUDIENCE = "authenticated";

export function createTokenVerifier(options: TokenVerifierOptions): TokenVerifier {
  const secretKey = options.jwtSecret ? new TextEncoder().encode(options.jwtSecret) : undefined;
  const keys = !secretKey && options.jwksUrl ? createRemoteJWKSet(new URL(options.jwksUrl)) : undefined;
  if (!secretKey && !keys) throw new Error("createTokenVerifier needs a jwtSecret or a jwksUrl");

  return async (token) => {
    if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
      throw new InvalidTokenError("malformed");
    }
    let payload: JWTPayload;
    try {
      // The algorithm list is fixed by how the verifier was built, never by what the token claims.
      // That is what stops "alg: none" and key-confusion attacks (an HS256 token signed with a
      // public key, for example).
      const common = { issuer: options.issuer, audience: AUDIENCE, clockTolerance: CLOCK_TOLERANCE_SECONDS };
      const result = secretKey
        ? await jwtVerify(token, secretKey, { ...common, algorithms: ["HS256"] })
        : await jwtVerify(token, keys as NonNullable<typeof keys>, { ...common, algorithms: ["ES256", "RS256", "EdDSA"] });
      payload = result.payload;
    } catch (error) {
      if (error instanceof joseErrors.JWTExpired) throw new InvalidTokenError("expired");
      if (error instanceof joseErrors.JWSSignatureVerificationFailed) throw new InvalidTokenError("bad_signature");
      throw new InvalidTokenError("malformed");
    }
    return accountFromClaims(payload);
  };
}

/** The verifier for this deployment's login project, from the validated environment. */
export function tokenVerifierFromEnv(env: Pick<ServerEnv, "NEXT_PUBLIC_SUPABASE_URL" | "SUPABASE_JWT_SECRET">): TokenVerifier {
  const issuer = `${env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/+$/, "")}/auth/v1`;
  return createTokenVerifier({
    issuer,
    ...(env.SUPABASE_JWT_SECRET ? { jwtSecret: env.SUPABASE_JWT_SECRET } : { jwksUrl: `${issuer}/.well-known/jwks.json` }),
  });
}
