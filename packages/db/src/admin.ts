// db.admin bypasses row-level security. Importable only by the console, cron jobs (jobs/),
// packages/db and scripts: enforced by a lint rule in @retail/config (PLAN.md §2.4).
//
// Use it for platform-level work (creating tenants, billing, the console, migrations). If you
// are handling a tenant's request, you want `createTenantDb().rls()` from "@retail/db" instead.
import type { Sql } from "postgres";
import { connect, type ConnectionOptions, type Database } from "./internal/connect";

export * from "./tenants";

export interface AdminDb {
  /** Typed Drizzle handle. Connected as the database owner: row-level security does NOT apply. */
  db: Database;
  /** The underlying postgres.js client, for raw SQL. */
  sql: Sql;
  close(): Promise<void>;
}

export function createAdminDb(url: string, options?: ConnectionOptions): AdminDb {
  const { client, db } = connect(url, options);
  return { db, sql: client, close: () => client.end() };
}
