import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { connect } from "./internal/connect";

/**
 * The one and only migration runner (PLAN.md D1: the single-tenant reference app drifted because schema changes
 * were pasted into a SQL editor). Migrations live in ./migrations and run in order, once each.
 */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../migrations", import.meta.url));

export const APP_ROLE = "retail_app";
export const MIN_APP_PASSWORD_LENGTH = 16;

export async function runMigrations(adminUrl: string): Promise<void> {
  const { client, db } = connect(adminUrl, { max: 1 });
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await client.end();
  }
}

/**
 * Let the shop app log in as `retail_app`. The role is created without LOGIN by migration
 * 0001 so that no credential is ever stored in a migration; the password comes from the
 * environment of whoever runs this.
 */
export async function enableAppRoleLogin(adminUrl: string, password: string): Promise<void> {
  if (password.length < MIN_APP_PASSWORD_LENGTH) {
    throw new Error(`APP_DB_PASSWORD must be at least ${MIN_APP_PASSWORD_LENGTH} characters`);
  }
  const { client } = connect(adminUrl, { max: 1 });
  try {
    // A password cannot be a bind parameter in ALTER ROLE, so let Postgres quote it (%L).
    const [row] = await client<{ stmt: string }[]>`
      select format('alter role %I with login password %L', ${APP_ROLE}::text, ${password}::text) as stmt`;
    if (!row) throw new Error("could not build ALTER ROLE statement");
    await client.unsafe(row.stmt);
  } finally {
    await client.end();
  }
}
