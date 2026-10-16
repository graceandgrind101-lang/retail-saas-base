import type { TestProject } from "vitest/node";
import { startTestDatabase } from "@retail/db/testing";

declare module "vitest" {
  export interface ProvidedContext {
    /** Owner connection to the web tests' own database (bypasses RLS). For setting up shops. */
    adminUrl: string;
    /** Login as `retail_app`, exactly what the running app uses. */
    appUrl: string;
  }
}

// The web tests get their own brand-new migrated database on the throwaway test server (started
// by `pnpm db:up`), separate from the database package's, so the two never interfere.
export default async function setup(project: TestProject): Promise<void> {
  const { adminUrl, appUrl } = await startTestDatabase("retail_test_web");
  project.provide("adminUrl", adminUrl);
  project.provide("appUrl", appUrl);
}
