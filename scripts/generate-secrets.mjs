// Prints fresh random values for the app's own secrets (see apps/web/.env.example).
// Output goes to your terminal only. Copy the lines into apps/web/.env.local.
import { randomBytes } from "node:crypto";

for (const name of ["SESSION_SECRET", "PIN_PEPPER", "DEVICE_TOKEN_PEPPER", "REFERENCE_PEPPER"]) {
  console.log(`${name}=${randomBytes(32).toString("base64url")}`);
}
