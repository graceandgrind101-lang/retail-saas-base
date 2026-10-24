// pnpm dev:setup
// One-time setup for trying the app on YOUR computer:
//   1. writes apps/web/.env.local with fresh random secrets and the local database address,
//   2. applies the database migrations and enables the app's own (limited) database login,
//   3. turns on the developer sign-in (ALLOW_DEV_SIGN_IN=1), which a production build refuses.
// It never overwrites an existing apps/web/.env.local. Needs the local database: pnpm db:up
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const envFile = join(root, "apps", "web", ".env.local");
const ADMIN_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

if (existsSync(envFile)) {
  console.log(`apps/web/.env.local already exists, so it is left alone.\nTo start over: delete it, run "pnpm db:reset", then "pnpm dev:setup" again.`);
  process.exit(0);
}

const secret = () => randomBytes(32).toString("base64url");
const appDbPassword = secret();
const lines = [
  "# Made by `pnpm dev:setup` for local development only. Never commit this file.",
  "# The two Supabase values are placeholders: signing in with an account is not connected yet.",
  "NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321",
  `NEXT_PUBLIC_SUPABASE_ANON_KEY=local-placeholder-anon-${secret()}`,
  "NEXT_PUBLIC_APP_URL=http://localhost:3000",
  `DATABASE_URL=postgresql://retail_app:${appDbPassword}@127.0.0.1:54322/postgres`,
  `SUPABASE_SERVICE_ROLE_KEY=local-placeholder-service-${secret()}`,
  "SUPABASE_JWT_SECRET=",
  `SESSION_SECRET=${secret()}`,
  `PIN_PEPPER=${secret()}`,
  `DEVICE_TOKEN_PEPPER=${secret()}`,
  `REFERENCE_PEPPER=${secret()}`,
  "",
  "# Lets you enter as the demo shop's owner (see `pnpm dev:seed`). A production build refuses to start with this set.",
  "ALLOW_DEV_SIGN_IN=1",
  "",
];
writeFileSync(envFile, lines.join("\n"), { encoding: "utf8", flag: "wx" });
console.log("Wrote apps/web/.env.local");

const migrate = spawnSync("npm", ["run", "db:migrate"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
  env: { ...process.env, DATABASE_ADMIN_URL: process.env.DATABASE_ADMIN_URL ?? ADMIN_URL, APP_DB_PASSWORD: appDbPassword },
});
if (migrate.status !== 0) {
  console.error("\nThe database step failed. Is the local database running? Start it with: npm run db:up   (Docker Desktop must be open)");
  console.error("Then delete apps/web/.env.local and run npm run dev:setup again.");
  process.exit(1);
}
console.log("\nDone. Next:  npm run dev:seed   then   npm run dev");
