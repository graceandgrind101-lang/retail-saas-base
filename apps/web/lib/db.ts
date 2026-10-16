import { createTenantDb, type TenantDb } from "@retail/db";
import { serverEnv } from "./env";

// One pool per server process. Kept on globalThis so a development reload does not leak connections.
const holder = globalThis as unknown as { __retailTenantDb?: TenantDb };

/** The shop app's database handle: connects as the limited `retail_app` login and can only run through `rls()`/`identity()`. */
export function tenantDb(): TenantDb {
  holder.__retailTenantDb ??= createTenantDb(serverEnv().DATABASE_URL, { max: 5 });
  return holder.__retailTenantDb;
}
