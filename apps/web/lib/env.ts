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
export function serverEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}

/** Test helper: forget the cached value. */
export function resetServerEnvCache(): void {
  cached = undefined;
}
