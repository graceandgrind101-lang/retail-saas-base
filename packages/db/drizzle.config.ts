import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` only reads the TypeScript schema; it never connects to a database.
// Migrations are applied by `pnpm --filter @retail/db migrate` (src/bin/migrate.ts), the one
// and only migration runner. Do not use `drizzle-kit push`: it skips the migration history.
//
// The schema files are listed one by one on purpose. src/schema/audit.ts describes the audit
// log for typed READING only; its table is created and locked down by a hand-written migration
// (0002), so drizzle-kit must never see it. (schemaFilter does not prevent that: it only
// filters what drizzle-kit reads from a live database.) A test guards both directions.
export default defineConfig({
  dialect: "postgresql",
  schema: [
    "./src/schema/platform.ts",
    "./src/schema/tenant-table.ts",
    "./src/schema/branches.ts",
    "./src/schema/roles.ts",
    "./src/schema/staff.ts",
    "./src/schema/devices.ts",
    "./src/schema/sessions.ts",
    "./src/schema/permissions.ts",
    "./src/schema/alerts.ts",
    "./src/schema/settings.ts",
  ],
  out: "./migrations",
  schemaFilter: ["platform", "app"],
});
