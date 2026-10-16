/**
 * The Node-only part of the startup check (Phase A task A2). Kept in its own file so
 * instrumentation.ts, which Next compiles for both runtimes, never mentions `process.exit`.
 *
 * Verified against a real `next start` (2026-10-16): Next logs a thrown error but keeps the
 * process alive, serving HTTP 500 for everything. Throwing alone is therefore not enough, so we
 * exit explicitly. `exit` is a parameter only so tests don't kill the test runner.
 *
 * If a runtime ignores the hook (or `exit` does nothing), `serverEnv()` in lib/env.ts still
 * throws on first use, so a bad environment can never be used.
 */
export async function checkEnvironmentAtBoot(exit: (code: number) => void = (code) => process.exit(code)): Promise<void> {
  const { serverEnv } = await import("./lib/env");
  try {
    serverEnv();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid environment, refusing to start");
    exit(1);
    throw error; // only reached when `exit` returns (tests, odd runtimes)
  }
}
