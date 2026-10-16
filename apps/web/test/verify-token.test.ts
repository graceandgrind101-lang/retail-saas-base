import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InvalidTokenError } from "@retail/core";
import { createTokenVerifier, tokenVerifierFromEnv } from "../lib/auth/verify-token";
import { TEST_ISSUER, TEST_JWT_SECRET, TEST_SUPABASE_URL, mintToken, unsignedToken } from "./tokens";

const USER = "018f0000-0000-7000-8000-0000000000aa";
const account = { sub: USER, email: "Owner@Example.com" };

const verify = createTokenVerifier({ issuer: TEST_ISSUER, jwtSecret: TEST_JWT_SECRET });
const problemOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "accepted",
    (error: unknown) => (error instanceof InvalidTokenError ? error.problem : `other: ${String(error)}`),
  );

describe("token verification with a shared secret (HS256)", () => {
  it("accepts a normal token and returns the verified account", async () => {
    expect(await verify(await mintToken({ ...account, provider: "google" }))).toEqual({
      authUserId: USER,
      email: "owner@example.com",
      provider: "google",
    });
  });

  it("refuses an expired token", async () => {
    expect(await problemOf(verify(await mintToken({ ...account, expiresIn: -60 })))).toBe("expired");
  });

  it("tolerates a few seconds of clock difference, but not minutes", async () => {
    expect(await problemOf(verify(await mintToken({ ...account, expiresIn: -2 })))).toBe("accepted");
    expect(await problemOf(verify(await mintToken({ ...account, expiresIn: -30 })))).toBe("expired");
  });

  it("refuses a token signed with a different secret", async () => {
    const token = await mintToken({ ...account, secret: "Zx6cVb3nMq8wEr1tYu4iOp7aSd2fGh5j" });
    expect(await problemOf(verify(token))).toBe("bad_signature");
  });

  it("refuses a token whose body was changed after signing", async () => {
    const token = await mintToken(account);
    const [header, , signature] = token.split(".") as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ sub: "018f0000-0000-7000-8000-0000000000bb", email: "evil@example.com", aud: "authenticated", role: "authenticated", iss: TEST_ISSUER, exp: 4_102_444_800, user_metadata: { email_verified: true } })).toString("base64url");
    expect(await problemOf(verify(`${header}.${forged}.${signature}`))).toBe("bad_signature");
  });

  it("refuses an UNSIGNED token (alg: none), however convincing its claims", async () => {
    const forged = unsignedToken({ sub: USER, email: "owner@example.com", aud: "authenticated", role: "authenticated", iss: TEST_ISSUER, exp: 4_102_444_800, user_metadata: { email_verified: true } });
    expect(await problemOf(verify(forged))).toBe("malformed");
  });

  it.each(["HS384", "HS512"] as const)("refuses a token signed with the wrong algorithm (%s): the verifier, not the token, chooses", async (alg) => {
    expect(await problemOf(verify(await mintToken({ ...account, alg })))).not.toBe("accepted");
  });

  it("refuses a token from another project (wrong issuer)", async () => {
    expect(await problemOf(verify(await mintToken({ ...account, issuer: "https://other.supabase.co/auth/v1" })))).toBe("malformed");
  });

  it("refuses a token for the wrong audience", async () => {
    expect(await problemOf(verify(await mintToken({ ...account, audience: "anon" })))).toBe("malformed");
  });

  it("refuses the project's public 'anon' key, which is a validly signed token with role 'anon'", async () => {
    expect(await problemOf(verify(await mintToken({ ...account, role: "anon" })))).toBe("wrong_role");
  });

  it("refuses a token whose email the provider has not verified", async () => {
    expect(await problemOf(verify(await mintToken({ ...account, emailVerified: false })))).toBe("email_not_verified");
  });

  it("refuses an anonymous sign-in", async () => {
    expect(await problemOf(verify(await mintToken({ ...account, claims: { is_anonymous: true } })))).toBe("anonymous");
  });

  it.each(["", "garbage", "a.b", "a.b.c", "x".repeat(9000), "Bearer abc", " "])("refuses the non-token %j", async (token) => {
    expect(await problemOf(verify(token))).toMatch(/malformed|bad_signature/);
  });

  it("gives the same message for every failure", async () => {
    const messages = new Set<string>();
    for (const token of ["junk", await mintToken({ ...account, expiresIn: -99 }), await mintToken({ ...account, role: "anon" }), await mintToken({ ...account, secret: "Zx6cVb3nMq8wEr1tYu4iOp7aSd2fGh5j" })]) {
      try {
        await verify(token);
      } catch (error) {
        messages.add((error as Error).message);
      }
    }
    expect(messages.size).toBe(1);
  });

  it("will not be built without a way to check signatures", () => {
    expect(() => createTokenVerifier({ issuer: TEST_ISSUER })).toThrow(/jwtSecret or a jwksUrl/);
  });
});

describe("tokenVerifierFromEnv", () => {
  it("derives the issuer from the project address and uses the shared secret when there is one", async () => {
    const fromEnv = tokenVerifierFromEnv({ NEXT_PUBLIC_SUPABASE_URL: `${TEST_SUPABASE_URL}/`, SUPABASE_JWT_SECRET: TEST_JWT_SECRET });
    expect((await fromEnv(await mintToken(account))).authUserId).toBe(USER);
    expect(await problemOf(fromEnv(await mintToken({ ...account, issuer: `${TEST_SUPABASE_URL}//auth/v1` })))).toBe("malformed");
  });

  it("falls back to the project's published public keys when there is no shared secret", () => {
    expect(() => tokenVerifierFromEnv({ NEXT_PUBLIC_SUPABASE_URL: TEST_SUPABASE_URL, SUPABASE_JWT_SECRET: undefined })).not.toThrow();
  });
});

describe("token verification with published public keys (ES256)", () => {
  let server: Server;
  let jwksUrl = "";
  let signing: Awaited<ReturnType<typeof generateKeyPair>>;
  let other: Awaited<ReturnType<typeof generateKeyPair>>;

  beforeAll(async () => {
    signing = await generateKeyPair("ES256");
    other = await generateKeyPair("ES256");
    const jwk = { ...(await exportJWK(signing.publicKey)), kid: "key-1", alg: "ES256", use: "sig" };
    server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    jwksUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks.json`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const signEs = (privateKey: CryptoKey | Uint8Array | object, kid = "key-1", extra: Record<string, unknown> = {}) =>
    new SignJWT({ role: "authenticated", email: account.email, user_metadata: { email_verified: true }, app_metadata: { provider: "google" }, ...extra })
      .setProtectedHeader({ alg: "ES256", kid })
      .setIssuer(TEST_ISSUER)
      .setAudience("authenticated")
      .setSubject(USER)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey as CryptoKey);

  it("accepts a token signed by the published key", async () => {
    const verifyKeys = createTokenVerifier({ issuer: TEST_ISSUER, jwksUrl });
    expect((await verifyKeys(await signEs(signing.privateKey))).email).toBe("owner@example.com");
  });

  it("refuses a token signed by some other key, even with the right key id", async () => {
    const verifyKeys = createTokenVerifier({ issuer: TEST_ISSUER, jwksUrl });
    expect(await problemOf(verifyKeys(await signEs(other.privateKey)))).not.toBe("accepted");
  });

  it("refuses a token naming a key id that is not published", async () => {
    const verifyKeys = createTokenVerifier({ issuer: TEST_ISSUER, jwksUrl });
    expect(await problemOf(verifyKeys(await signEs(signing.privateKey, "unknown-key")))).not.toBe("accepted");
  });

  it("refuses an HS256 token in this mode (key-confusion attack: signing with the public key as a secret)", async () => {
    const verifyKeys = createTokenVerifier({ issuer: TEST_ISSUER, jwksUrl });
    expect(await problemOf(verifyKeys(await mintToken(account)))).not.toBe("accepted");
    const publicJwk = JSON.stringify(await exportJWK(signing.publicKey));
    expect(await problemOf(verifyKeys(await mintToken({ ...account, secret: publicJwk })))).not.toBe("accepted");
  });

  it("still applies the claim rules (a correctly signed anon token is refused)", async () => {
    const verifyKeys = createTokenVerifier({ issuer: TEST_ISSUER, jwksUrl });
    expect(await problemOf(verifyKeys(await signEs(signing.privateKey, "key-1", { role: "anon" })))).toBe("wrong_role");
  });
});
