import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` only reads the TypeScript schema; it never connects to a database.
// Migrations are applied by `pnpm --filter @retail/db migrate` (src/bin/migrate.ts), the one
// and only migration runner. Do not use `drizzle-kit push`: it skips the migration history.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  schemaFilter: ["platform", "app"],
});
