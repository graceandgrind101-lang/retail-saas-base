import { tenantDb } from "../db";
import { serverEnv } from "../env";
import { createSettingsHandlers, type SettingsHandlers } from "./handlers";

let handlers: SettingsHandlers | undefined;

/** The settings handlers wired to this deployment's environment. Built on first use. */
export function settingsHandlers(): SettingsHandlers {
  if (!handlers) {
    const env = serverEnv();
    handlers = createSettingsHandlers({ db: tenantDb(), sessionSecret: env.SESSION_SECRET, appUrl: env.NEXT_PUBLIC_APP_URL });
  }
  return handlers;
}

/** Test helper: forget the wiring so the next call rebuilds it from the current environment. */
export function resetSettingsHandlers(): void {
  handlers = undefined;
}
