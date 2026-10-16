import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "../schema";

export type Schema = typeof schema;
export type Database = PostgresJsDatabase<Schema>;

export interface ConnectionOptions {
  /** Maximum pooled connections. Default 10. */
  max?: number;
}

/**
 * Not exported from the package: tenant code must go through `createTenantDb().rls()` and
 * admin code through `@retail/db/admin`, never through a raw connection.
 *
 * `prepare: false` keeps this working behind transaction-mode poolers (pgbouncer, Cloudflare
 * Hyperdrive), which matters because the plan keeps hosting portable (PLAN.md D13).
 */
export function connect(url: string, options: ConnectionOptions = {}): { client: Sql; db: Database } {
  const client = postgres(url, {
    max: options.max ?? 10,
    prepare: false,
    onnotice: () => {},
  });
  return { client, db: drizzle(client, { schema }) };
}
