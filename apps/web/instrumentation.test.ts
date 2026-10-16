import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvError } from "@retail/core";
import { resetServerEnvCache } from "./lib/env";
import { register } from "./instrumentation";
import { checkEnvironmentAtBoot } from "./instrumentation-node";

// Test-only values (unique, high entropy). Not real secrets.
const valid: Record<string, string> = {
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

function setEnv(values: Record<string, string | undefined>) {
  for (const name of Object.keys(valid)) vi.stubEnv(name, values[name]);
}

describe("boot check (instrumentation-node.checkEnvironmentAtBoot)", () => {
  beforeEach(() => {
    resetServerEnvCache();
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetServerEnvCache();
  });

  it("lets the server start when every value is present, without exiting", async () => {
    setEnv(valid);
    const exit = vi.fn();
    await expect(checkEnvironmentAtBoot(exit)).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
  });

  it("exits the process with code 1 when a secret is missing, and says which one", async () => {
    setEnv({ ...valid, PIN_PEPPER: undefined });
    const exit = vi.fn();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = await checkEnvironmentAtBoot(exit).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(failure).toBeInstanceOf(EnvError);
    expect((failure as EnvError).problems.some((p) => p.startsWith("PIN_PEPPER:"))).toBe(true);
    expect(String(log.mock.calls[0]?.[0])).toContain("PIN_PEPPER");
    log.mockRestore();
  });

  it("exits when the environment is empty", async () => {
    setEnv({});
    const exit = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(checkEnvironmentAtBoot(exit)).rejects.toBeInstanceOf(EnvError);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("the hook does nothing outside the Node.js runtime (edge has no secrets to check)", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    setEnv({});
    await expect(register()).resolves.toBeUndefined();
  });

  it("the hook runs the check on Node, and lets a valid environment through", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    setEnv(valid);
    await expect(register()).resolves.toBeUndefined();
  });
});
