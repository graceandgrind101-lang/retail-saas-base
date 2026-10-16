import type { TestProject } from "vitest/node";
import { startTestDatabase } from "../src/testing";

declare module "vitest" {
  export interface ProvidedContext {
    /** Owner connection to the fresh test database (bypasses RLS). */
    adminUrl: string;
    /** Login as `retail_app`, exactly what the shop app uses in production. */
    appUrl: string;
  }
}

// A brand-new migrated database for this package (see src/testing.ts for what it does and why
// it is checked before any test runs). The web app's tests use their own database on the same server.
export default async function setup(project: TestProject): Promise<void> {
  const { adminUrl, appUrl } = await startTestDatabase("retail_test");
  project.provide("adminUrl", adminUrl);
  project.provide("appUrl", appUrl);
}
