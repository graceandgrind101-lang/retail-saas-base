// pnpm dev:seed
// Creates (or reuses) a demo shop on YOUR LOCAL database and prints how to sign in.
//   DATABASE_ADMIN_URL   owner connection to the local database (default: the local dev database)
//   The peppers are read from apps/web/.env.local, so the codes it makes work in the app you run.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { DEMO_SLUG, seedDemoShop } from "../dev-seed";

const DEFAULT_ADMIN_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const adminUrl = process.env.DATABASE_ADMIN_URL ?? DEFAULT_ADMIN_URL;
const host = new URL(adminUrl).hostname;
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
  fail(`dev:seed only works on a database on this computer (got ${host}). It creates people with PINs that are written in the source code.`);
}

const envFile = join(fileURLToPath(new URL("../../../../apps/web/", import.meta.url)), ".env.local");
let text = "";
try {
  text = readFileSync(envFile, "utf8");
} catch {
  fail(`Cannot read ${envFile}.\nCopy apps/web/.env.example to apps/web/.env.local and fill it in first (pnpm secrets:generate makes the secrets).`);
}
const env = Object.fromEntries(
  text
    .split(/\r?\n/)
    .map((line) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [m[1] as string, (m[2] as string).replace(/^["']|["']$/g, "")]),
);
const devicePepper = env.DEVICE_TOKEN_PEPPER;
const pinPepper = env.PIN_PEPPER;
if (!devicePepper || !pinPepper) fail("DEVICE_TOKEN_PEPPER and PIN_PEPPER must be set in apps/web/.env.local");

const sql = postgres(adminUrl, { max: 1, onnotice: () => {}, prepare: false });
try {
  const seed = await seedDemoShop(sql, { devicePepper, pinPepper });
  const appUrl = env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  console.log(`\n${seed.created ? "Created" : "Found"} the demo shop (address "${DEMO_SLUG}").\n`);
  console.log(`1. Start the app:   pnpm dev   (and make sure ALLOW_DEV_SIGN_IN=1 is in apps/web/.env.local)`);
  console.log(`2. Open ${appUrl}/sign-in`);
  console.log(`   - "Sign in as the demo owner" opens the admin app as the owner.`);
  console.log(`   - To try a till: connect a device with the code  ${seed.pairingCode}  (valid 10 minutes, once),`);
  console.log(`     then sign in with a PIN:  Demo Manager ${seed.pins.manager}   Demo Cashier ${seed.pins.cashier}`);
  console.log(`   Run this command again for a fresh code.\n`);
} finally {
  await sql.end();
}
