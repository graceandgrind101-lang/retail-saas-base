// Tenant-facing database access. Nothing exported here can run an unscoped query.
// Platform work (console, jobs, scripts) uses "@retail/db/admin" instead.
export * from "./rls";
export * from "./schema";
export type { ConnectionOptions, Database } from "./internal/connect";
