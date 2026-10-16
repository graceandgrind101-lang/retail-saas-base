// pnpm --filter @retail/db migrate
//   DATABASE_ADMIN_URL  owner connection (required)
//   APP_DB_PASSWORD     if set, lets the shop app log in as retail_app (>= 16 chars)
import { z } from "zod";
import { enableAppRoleLogin, runMigrations } from "../migrate";

const env = z
  .object({
    DATABASE_ADMIN_URL: z.string().min(1, "is empty").startsWith("postgres", "must be a postgres:// URL"),
    APP_DB_PASSWORD: z.string().min(16, "must be at least 16 characters").optional(),
  })
  .safeParse(process.env);

if (!env.success) {
  // Names and reasons only, never values.
  for (const issue of env.error.issues) console.error(`${issue.path.join(".")}: ${issue.message}`);
  process.exit(1);
}

await runMigrations(env.data.DATABASE_ADMIN_URL);
console.log("migrations applied");

if (env.data.APP_DB_PASSWORD) {
  await enableAppRoleLogin(env.data.DATABASE_ADMIN_URL, env.data.APP_DB_PASSWORD);
  console.log("retail_app can now log in");
} else {
  console.log("retail_app has no login yet: set APP_DB_PASSWORD and run again");
}
