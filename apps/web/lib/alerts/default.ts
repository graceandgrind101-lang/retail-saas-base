import { tenantDb } from "../db";
import { serverEnv } from "../env";
import { createAlertHandlers, type AlertHandlers } from "./handlers";

let handlers: AlertHandlers | undefined;

/** The alert handlers wired to this deployment's environment. Built on first use. */
export function alertHandlers(): AlertHandlers {
  if (!handlers) {
    const env = serverEnv();
    handlers = createAlertHandlers({ db: tenantDb(), sessionSecret: env.SESSION_SECRET, appUrl: env.NEXT_PUBLIC_APP_URL });
  }
  return handlers;
}

/** Test helper: forget the wiring so the next call rebuilds it from the current environment. */
export function resetAlertHandlers(): void {
  handlers = undefined;
}
