/**
 * Runs once when the server starts and must finish before it accepts requests
 * (Next docs: instrumentation.js). If the environment is invalid the process exits, so it never
 * sits "up" while answering every request with an error: "refuses to boot" (Phase A task A2).
 *
 * The Node-only work is in instrumentation-node.ts, imported only when running on Node, so this
 * file stays free of Node APIs (Next compiles it for the Edge runtime as well).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { checkEnvironmentAtBoot } = await import("./instrumentation-node");
    await checkEnvironmentAtBoot();
  }
}
