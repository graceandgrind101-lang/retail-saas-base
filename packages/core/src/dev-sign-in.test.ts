import { describe, expect, it } from "vitest";
import { DEV_DEMO_OWNER_ACCOUNT_ID, devSignInEnabled, devSignInProblem } from "./dev-sign-in";
import { EnvError, parseServerEnv } from "./env";
import { isUuid } from "./uuid";

const valid = {
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-0123456789-abcdefghij",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key-0123456789-ABCDEFGHIJ",
  SESSION_SECRET: "k3Jf9aQ2xLm7ZpR1tVb8nWc4yHd6sGu0",
  PIN_PEPPER: "Qw8eRt5yUi2oPa7sDf4gHj1kLz9xCv3b",
  DEVICE_TOKEN_PEPPER: "Zx6cVb3nMq8wEr1tYu4iOp7aSd2fGh5j",
  REFERENCE_PEPPER: "Lk9jHg6fDs3aPo0iUy7tRe4wQz1xCv8n",
};

describe("developer sign-in switch", () => {
  it("is on only with ALLOW_DEV_SIGN_IN=1 outside a production build", () => {
    expect(devSignInEnabled({ ALLOW_DEV_SIGN_IN: "1", NODE_ENV: "development" })).toBe(true);
    expect(devSignInEnabled({ ALLOW_DEV_SIGN_IN: "1", NODE_ENV: "test" })).toBe(true);
    expect(devSignInEnabled({ ALLOW_DEV_SIGN_IN: "1" })).toBe(true);
    expect(devSignInEnabled({ ALLOW_DEV_SIGN_IN: "1", NODE_ENV: "production" })).toBe(false);
  });

  it("is off for anything else, including 'true', 'yes' and empty", () => {
    for (const value of [undefined, "", "0", "true", "yes", "TRUE", " 1", "1 ", "on"]) {
      expect(devSignInEnabled({ ALLOW_DEV_SIGN_IN: value, NODE_ENV: "development" }), String(value)).toBe(false);
    }
  });

  it("a production build is told the setting is dangerous whenever it is set at all", () => {
    expect(devSignInProblem({ NODE_ENV: "production", ALLOW_DEV_SIGN_IN: "1" })).toMatch(/must not be set in a production build/);
    expect(devSignInProblem({ NODE_ENV: "production", ALLOW_DEV_SIGN_IN: "0" })).toMatch(/ALLOW_DEV_SIGN_IN/);
    expect(devSignInProblem({ NODE_ENV: "production", ALLOW_DEV_SIGN_IN: "true" })).not.toBeNull();
    expect(devSignInProblem({ NODE_ENV: "production" })).toBeNull();
    expect(devSignInProblem({ NODE_ENV: "production", ALLOW_DEV_SIGN_IN: "" })).toBeNull();
    expect(devSignInProblem({ NODE_ENV: "development", ALLOW_DEV_SIGN_IN: "1" })).toBeNull();
    expect(devSignInProblem({ ALLOW_DEV_SIGN_IN: "1" })).toBeNull();
  });

  it("a production server with the setting refuses to start, naming the setting", () => {
    expect(() => parseServerEnv({ ...valid, NODE_ENV: "production", ALLOW_DEV_SIGN_IN: "1" })).toThrow(EnvError);
    try {
      parseServerEnv({ ...valid, NODE_ENV: "production", ALLOW_DEV_SIGN_IN: "1" });
    } catch (error) {
      expect((error as EnvError).problems.join("\n")).toContain("ALLOW_DEV_SIGN_IN");
    }
    // and reports it together with other problems, not instead of them
    try {
      parseServerEnv({ ...valid, SESSION_SECRET: "short", NODE_ENV: "production", ALLOW_DEV_SIGN_IN: "1" });
    } catch (error) {
      const problems = (error as EnvError).problems.join("\n");
      expect(problems).toContain("SESSION_SECRET");
      expect(problems).toContain("ALLOW_DEV_SIGN_IN");
    }
  });

  it("development, and production without the setting, start fine", () => {
    expect(() => parseServerEnv({ ...valid, NODE_ENV: "development", ALLOW_DEV_SIGN_IN: "1" })).not.toThrow();
    expect(() => parseServerEnv({ ...valid, NODE_ENV: "production" })).not.toThrow();
  });

  it("the demo owner's account id is a valid UUID", () => {
    expect(isUuid(DEV_DEMO_OWNER_ACCOUNT_ID)).toBe(true);
  });
});
