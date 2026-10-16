import { tenantDb } from "../db";
import { serverEnv } from "../env";
import { createAuthHandlers, type AuthHandlers } from "./handlers";
import { tokenVerifierFromEnv } from "./verify-token";

let handlers: AuthHandlers | undefined;

/** The sign-in handlers wired to this deployment's environment. Built on first use, so importing a route needs no secrets. */
export function authHandlers(): AuthHandlers {
  if (!handlers) {
    const env = serverEnv();
    handlers = createAuthHandlers({
      db: tenantDb(),
      verifyToken: tokenVerifierFromEnv(env),
      sessionSecret: env.SESSION_SECRET,
      appUrl: env.NEXT_PUBLIC_APP_URL,
    });
  }
  return handlers;
}

/** Test helper: forget the wiring so the next call rebuilds it from the current environment. */
export function resetAuthHandlers(): void {
  handlers = undefined;
}
