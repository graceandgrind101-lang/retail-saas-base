import postgres from "postgres";
import { checkDatabaseSecurity, formatViolations } from "./ci/security-check";
import { enableAppRoleLogin, runMigrations } from "./migrate";

/**
 * A fresh, fully migrated database for tests, shared by the database tests and the web app's
 * tests. NOT for production use: it drops and recreates a database.
 *
 * It only ever talks to the throwaway test container (infra/dev-db/compose.yaml `db-test`,
 * port 54323, memory-backed), never to the development data.
 */

const DEFAULT_URL = "postgresql://postgres:postgres@127.0.0.1:54323/postgres";

/**
 * The password of the `retail_app` login on the throwaway test server. Roles are shared by a
 * whole Postgres server, so every test database on it must agree on one value, or two test runs
 * would change the password under each other. It protects nothing: the container is local,
 * bound to 127.0.0.1, and wiped when it stops.
 */
export const TEST_APP_PASSWORD = "retail-test-only-app-password-0001";

/** Held while a test database is built, so two packages starting at once cannot collide on the shared roles. */
const SETUP_LOCK = 70_010_001;

export interface TestDatabase {
  /** Owner connection to the new database (bypasses row-level security). */
  adminUrl: string;
  /** A login as `retail_app`, exactly what the shop app uses in production. */
  appUrl: string;
}

function withDatabase(url: string, database: string): URL {
  const next = new URL(url);
  next.pathname = `/${database}`;
  return next;
}

/** `databaseName` lets two packages each have their own database on the same server. */
export async function startTestDatabase(databaseName = "retail_test"): Promise<TestDatabase> {
  if (!/^[a-z][a-z0-9_]*$/.test(databaseName)) throw new Error(`unsafe database name: ${databaseName}`);
  const baseUrl = process.env.TEST_DATABASE_ADMIN_URL ?? DEFAULT_URL;
  const maintenance = postgres(baseUrl, { max: 2, onnotice: () => {}, connect_timeout: 10 });

  try {
    try {
      await maintenance`select 1`;
    } catch {
      const { host, port } = new URL(baseUrl);
      throw new Error(
        `Cannot reach the test database at ${host}:${port}.\n` +
          `Start it with:  pnpm db:up   (needs Docker Desktop running)\n` +
          `Or point TEST_DATABASE_ADMIN_URL at a throwaway Postgres 17 (Supabase image).`,
      );
    }

    const lock = await maintenance.reserve();
    try {
      await lock`select pg_advisory_lock(${SETUP_LOCK})`;

      // Always a brand-new database, so no run can depend on leftovers from another.
      await maintenance.unsafe(`drop database if exists ${databaseName} with (force)`);
      await maintenance.unsafe(`create database ${databaseName}`);

      const adminUrl = withDatabase(baseUrl, databaseName);
      await runMigrations(adminUrl.toString());
      await enableAppRoleLogin(adminUrl.toString(), TEST_APP_PASSWORD);

      // Verify the freshly migrated database BEFORE any test runs, and abort the whole run if it
      // is not secure. Tests deliberately loosen and restore settings (security-check.test.ts), so
      // checking later would depend on file order: a test could "repair" a bad migration before
      // anyone looked, and a mutation of the migration would go unnoticed.
      const verifier = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
      try {
        const violations = await checkDatabaseSecurity(verifier);
        if (violations.length > 0) {
          throw new Error(
            `The migrations produced an insecure database (${violations.length}):\n${formatViolations(violations)}`,
          );
        }
      } finally {
        await verifier.end();
      }

      const appUrl = withDatabase(baseUrl, databaseName);
      appUrl.username = "retail_app";
      appUrl.password = TEST_APP_PASSWORD;
      return { adminUrl: adminUrl.toString(), appUrl: appUrl.toString() };
    } finally {
      await lock`select pg_advisory_unlock(${SETUP_LOCK})`.catch(() => undefined);
      lock.release();
    }
  } finally {
    await maintenance.end({ timeout: 5 });
  }
}
