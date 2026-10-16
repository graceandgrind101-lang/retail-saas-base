// Tenant-facing database access. Nothing exported here can run an unscoped query.
// Platform work (console, jobs, scripts) uses "@retail/db/admin" instead.
export * from "./audit";
export * from "./rls";
export * from "./schema";
export * from "./tenant-info";
export type { ConnectionOptions, Database } from "./internal/connect";
