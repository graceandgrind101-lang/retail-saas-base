import { randomBytes } from "node:crypto";
import postgres from "postgres";
import type { TestProject } from "vitest/node";
import { checkDatabaseSecurity, formatViolations } from "../src/ci/security-check";
import { enableAppRoleLogin, runMigrations } from "../src/migrate";

declare module "vitest" {
  export interface ProvidedContext {
    /** Owner connection to the fresh test database (bypasses RLS). */
    adminUrl: string;
    /** Login as `retail_app`, exactly what the shop app uses in production. */
    appUrl: string;
  }
}

// The throwaway test container (infra/dev-db/compose.yaml: `db-test`, port 54323). Never your
// dev data: tests change role passwords, and roles are shared by a whole Postgres server.
const DEFAULT_URL = "postgresql://postgres:postgres@127.0.0.1:54323/postgres";
const TEST_DATABASE = "retail_test";

function withDatabase(url: string, database: string): URL {
  const next = new URL(url);
  next.pathname = `/${database}`;
  return next;
}

export default async function setup(project: TestProject): Promise<void> {
  const baseUrl = process.env.TEST_DATABASE_ADMIN_URL ?? DEFAULT_URL;
  const maintenance = postgres(baseUrl, { max: 1, onnotice: () => {}, connect_timeout: 10 });

  try {
    await maintenance`select 1`;
  } catch {
    await maintenance.end({ timeout: 1 }).catch(() => {});
    const { host, port } = new URL(baseUrl);
    throw new Error(
      `Cannot reach the test database at ${host}:${port}.\n` +
        `Start it with:  pnpm db:up   (needs Docker Desktop running)\n` +
        `Or point TEST_DATABASE_ADMIN_URL at a throwaway Postgres 17 (Supabase image).`,
    );
  }

  // Always a brand-new database, so no run can depend on leftovers from another.
  await maintenance.unsafe(`drop database if exists ${TEST_DATABASE} with (force)`);
  await maintenance.unsafe(`create database ${TEST_DATABASE}`);
  await maintenance.end();

  const adminUrl = withDatabase(baseUrl, TEST_DATABASE);
  await runMigrations(adminUrl.toString());

  const appPassword = randomBytes(24).toString("base64url");
  await enableAppRoleLogin(adminUrl.toString(), appPassword);

  // Verify the freshly migrated database BEFORE any test runs, and abort the whole run if it
  // is not secure. Tests deliberately loosen and restore settings (security-check.test.ts), so
  // checking later would depend on file order: a test could "repair" a bad migration before
  // anyone looked, and a mutation of the migration would go unnoticed.
  const verifier = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    const violations = await checkDatabaseSecurity(verifier);
    if (violations.length > 0) {
      throw new Error(
        `The migrations produced an insecure database (${violations.length}):
${formatViolations(violations)}`,
      );
    }
  } finally {
    await verifier.end();
  }

  const appUrl = withDatabase(baseUrl, TEST_DATABASE);
  appUrl.username = "retail_app";
  appUrl.password = appPassword;

  project.provide("adminUrl", adminUrl.toString());
  project.provide("appUrl", appUrl.toString());
}
