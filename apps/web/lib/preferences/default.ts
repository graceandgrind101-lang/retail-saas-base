import { tenantDb } from "../db";
import { serverEnv } from "../env";
import { createPreferenceHandlers, type PreferenceHandlers } from "./handlers";

let handlers: PreferenceHandlers | undefined;

/** The preference handlers wired to this deployment's environment. Built on first use. */
export function preferenceHandlers(): PreferenceHandlers {
  if (!handlers) {
    const env = serverEnv();
    handlers = createPreferenceHandlers({ db: tenantDb(), sessionSecret: env.SESSION_SECRET, appUrl: env.NEXT_PUBLIC_APP_URL });
  }
  return handlers;
}

/** Test helper: forget the wiring so the next call rebuilds it from the current environment. */
export function resetPreferenceHandlers(): void {
  handlers = undefined;
}
