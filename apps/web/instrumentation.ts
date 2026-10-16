/**
 * Runs once when the server starts and must finish before it accepts requests
 * (Next docs: instrumentation.js). If the environment is invalid the process exits, so it
 * never sits "up" while answering every request with an error. "Refuses to boot"
 * (Phase A task A2).
 *
 * Verified against a real `next start` (2026-10-16): Next logs a thrown error but keeps the
 * process alive, serving HTTP 500 for everything. Throwing alone is therefore not enough,
 * so we exit explicitly. `exit` is a parameter only so tests don't kill the test runner.
 *
 * If a runtime ignores this hook (or `exit` does nothing), `serverEnv()` in lib/env.ts still
 * throws on first use, so a bad environment can never be used.
 */
export async function register(exit: (code: number) => void = (code) => process.exit(code)): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { serverEnv } = await import("./lib/env");
  try {
    serverEnv();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid environment, refusing to start");
    exit(1);
    throw error; // only reached when `exit` returns (tests, odd runtimes)
  }
}
