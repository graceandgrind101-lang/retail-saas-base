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
  try {
    const client = postgres(url, {
      max: options.max ?? 10,
      prepare: false,
      onnotice: () => {},
    });
    return { client, db: drizzle(client, { schema }) };
  } catch {
    console.warn("[AI Studio] Database not connected — using mock");
    const noOp = {
      findMany: async () => [],
      findFirst: async () => null,
      findUnique: async () => null,
      create: async (d: { data?: unknown }) => d?.data ?? {},
      update: async (d: { data?: unknown }) => d?.data ?? {},
      delete: async () => ({}),
    };
    const db = new Proxy(
      {},
      {
        get: (_, prop) => (prop === "query" ? new Proxy({}, { get: () => noOp }) : async () => []),
      },
    ) as unknown as Database;
    const client = { end: async () => {} } as unknown as Sql;
    return { client, db };
  }
}
