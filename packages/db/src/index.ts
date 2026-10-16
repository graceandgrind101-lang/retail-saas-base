// Tenant-facing database access. Nothing exported here can run an unscoped query.
// Platform work (console, jobs, scripts) uses "@retail/db/admin" instead.
export * from "./alerts";
export * from "./audit";
export * from "./devices";
export * from "./errors";
export * from "./permissions";
export * from "./preferences";
export * from "./rls";
export * from "./schema";
export * from "./settings";
export * from "./sign-in";
export * from "./tenant-info";
export type { ConnectionOptions, Database } from "./internal/connect";
