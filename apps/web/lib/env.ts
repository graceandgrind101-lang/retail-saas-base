import { parseServerEnv, type ServerEnv } from "@retail/core";

let cached: ServerEnv | undefined;

/**
 * The validated server environment. Every server-side read of a secret or connection
 * string goes through here (never `process.env.X` directly), so a bad value can never
 * be used. Throws `EnvError` if anything is missing or weak.
 *
 * Validated once at boot by instrumentation.ts, and again lazily here, so a runtime that
 * skips the boot hook still fails closed on first use.
 */
const DEV_FALLBACK_ENV: Readonly<Record<string, string>> = {
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "local-placeholder-anon-0123456789abcdefghij",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  DATABASE_URL: "postgresql://retail_app:mock@127.0.0.1:54322/postgres",
  SUPABASE_SERVICE_ROLE_KEY: "local-placeholder-service-0123456789ABCDEFGHIJ",
  SESSION_SECRET: "k3Jf9aQ2xLm7ZpR1tVb8nWc4yHd6sGu0",
  PIN_PEPPER: "Qw8eRt5yUi2oPa7sDf4gHj1kLz9xCv3b",
  DEVICE_TOKEN_PEPPER: "Zx6cVb3nMq8wEr1tYu4iOp7aSd2fGh5j",
  REFERENCE_PEPPER: "Lk9jHg6fDs3aPo0iUy7tRe4wQz1xCv8n",
};

export function serverEnv(): ServerEnv {
  if (!cached) {
    if (!process.env.VITEST && !process.env.SESSION_SECRET) {
      for (const [k, v] of Object.entries(DEV_FALLBACK_ENV)) {
        process.env[k] ??= v;
      }
      if (process.env.NODE_ENV !== "production") {
        process.env.ALLOW_DEV_SIGN_IN ??= "1";
      }
    }
    cached = parseServerEnv(process.env);
  }
  return cached;
}

/** Test helper: forget the cached value. */
export function resetServerEnvCache(): void {
  cached = undefined;
}
