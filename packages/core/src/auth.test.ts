import { describe, expect, it } from "vitest";
import { InvalidTokenError, accountFromClaims, type TokenProblem } from "./auth";

const USER = "018f0000-0000-7000-8000-0000000000aa";

/** What a Supabase access token for a signed-in, email-verified person looks like. */
const claims = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: "https://project.supabase.co/auth/v1",
  aud: "authenticated",
  role: "authenticated",
  sub: USER,
  email: "Owner@Example.com",
  exp: 4_102_444_800,
  app_metadata: { provider: "google", providers: ["google"] },
  user_metadata: { email_verified: true, full_name: "Owner" },
  ...over,
});

const problemOf = (payload: unknown): TokenProblem | "accepted" => {
  try {
    accountFromClaims(payload);
    return "accepted";
  } catch (error) {
    if (error instanceof InvalidTokenError) return error.problem as TokenProblem;
    throw error;
  }
};

describe("accountFromClaims: who counts as a signed-in person", () => {
  it("accepts a normal token and normalises the email", () => {
    expect(accountFromClaims(claims())).toEqual({ authUserId: USER, email: "owner@example.com", provider: "google" });
  });

  it("lower-cases the account id and trims the email", () => {
    const account = accountFromClaims(claims({ sub: USER.toUpperCase(), email: "  Mixed.Case@Example.COM " }));
    expect(account.authUserId).toBe(USER);
    expect(account.email).toBe("mixed.case@example.com");
  });

  it("accepts an audience given as a list that includes 'authenticated'", () => {
    expect(problemOf(claims({ aud: ["something", "authenticated"] }))).toBe("accepted");
  });

  it("reports the provider when there is one, and null when there is not", () => {
    expect(accountFromClaims(claims({ app_metadata: { provider: "email" } })).provider).toBe("email");
    expect(accountFromClaims(claims({ app_metadata: {} })).provider).toBeNull();
    expect(accountFromClaims(claims({ app_metadata: undefined })).provider).toBeNull();
    expect(accountFromClaims(claims({ app_metadata: { provider: 42 } })).provider).toBeNull();
  });

  it.each([null, undefined, "a string", 42, ["array"], true])("refuses a payload that is not an object (%j)", (payload) => {
    expect(problemOf(payload)).toBe("not_an_object");
  });

  it.each([
    ["no audience", { aud: undefined }],
    ["the 'anon' audience", { aud: "anon" }],
    ["a list without 'authenticated'", { aud: ["anon", "service_role"] }],
    ["a number", { aud: 5 }],
  ])("refuses %s", (_label, over) => {
    expect(problemOf(claims(over))).toBe("wrong_audience");
  });

  it.each([
    ["the public anon key", { role: "anon" }],
    ["the service-role key", { role: "service_role" }],
    ["no role", { role: undefined }],
    ["a role of the wrong case", { role: "Authenticated" }],
  ])("refuses %s, even though it is a validly signed token", (_label, over) => {
    expect(problemOf(claims(over))).toBe("wrong_role");
  });

  it("refuses an anonymous sign-in", () => {
    expect(problemOf(claims({ is_anonymous: true }))).toBe("anonymous");
    expect(problemOf(claims({ is_anonymous: false }))).toBe("accepted");
  });

  it.each([
    ["missing", undefined],
    ["not a uuid", "owner-1"],
    ["a number", 7],
    ["the nil uuid", "00000000-0000-0000-0000-000000000000"],
    ["with trailing text", `${USER}x`],
  ])("refuses a subject that is %s", (_label, sub) => {
    expect(problemOf(claims({ sub }))).toBe("bad_subject");
  });

  it.each([
    ["missing", undefined],
    ["not a string", 5],
    ["without an @", "owner.example.com"],
    ["without a domain dot", "owner@example"],
    ["with a space", "own er@example.com"],
    ["empty", ""],
    ["too long", `${"x".repeat(250)}@example.com`],
  ])("refuses an email that is %s", (_label, email) => {
    expect(problemOf(claims({ email }))).toBe("no_email");
  });

  it.each([
    ["no user metadata", { user_metadata: undefined }],
    ["verification false", { user_metadata: { email_verified: false } }],
    ["verification missing", { user_metadata: {} }],
    ["verification as a string", { user_metadata: { email_verified: "true" } }],
    ["verification only in app metadata", { user_metadata: {}, app_metadata: { email_verified: true } }],
    ["user metadata that is not an object", { user_metadata: "verified" }],
  ])("refuses an unverified email: %s", (_label, over) => {
    expect(problemOf(claims(over))).toBe("email_not_verified");
  });

  it("gives the same message for every problem, so a caller cannot explain it to the browser", () => {
    const messages = new Set<string>();
    for (const payload of [null, claims({ aud: "x" }), claims({ role: "anon" }), claims({ sub: "x" }), claims({ email: 1 }), claims({ user_metadata: {} })]) {
      try {
        accountFromClaims(payload);
      } catch (error) {
        messages.add((error as Error).message);
      }
    }
    expect(messages.size).toBe(1);
  });

  it("checks the audience and role before anything about the person", () => {
    expect(problemOf(claims({ role: "anon", sub: "not-a-uuid", email: undefined }))).toBe("wrong_role");
  });
});
