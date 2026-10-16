import { tenantDb } from "../db";
import { serverEnv } from "../env";
import { createDevSignIn } from "./dev";

/** The developer sign-in wired to this process's environment. Built per call: it is cheap and reads the switch live. */
export function devSignIn() {
  const env = serverEnv();
  return createDevSignIn({ db: tenantDb(), sessionSecret: env.SESSION_SECRET, appUrl: env.NEXT_PUBLIC_APP_URL, env: process.env });
}
