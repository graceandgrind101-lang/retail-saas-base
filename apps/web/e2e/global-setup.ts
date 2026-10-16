import { startTestDatabase } from "@retail/db/testing";

// A brand-new, fully migrated database for the browser tests, on the throwaway test server.
export default async function globalSetup(): Promise<void> {
  const database = await startTestDatabase("retail_test_e2e");
  process.env.E2E_ADMIN_URL = database.adminUrl;
}
