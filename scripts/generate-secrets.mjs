// Prints fresh random values for the app's own secrets (see apps/web/.env.example).
// Output goes to your terminal only. Copy the lines into apps/web/.env.local.
// APP_DB_PASSWORD is the password for the `retail_app` database login (D26); it is read by
// `pnpm db:migrate` and also goes inside DATABASE_URL. It is base64url, so it is safe in a URL.
import { randomBytes } from "node:crypto";

for (const name of ["SESSION_SECRET", "PIN_PEPPER", "DEVICE_TOKEN_PEPPER", "REFERENCE_PEPPER", "APP_DB_PASSWORD"]) {
  console.log(`${name}=${randomBytes(32).toString("base64url")}`);
}
