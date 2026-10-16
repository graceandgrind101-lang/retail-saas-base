import { tenantDb } from "../db";
import { serverEnv } from "../env";
import { createPermissionHandlers, type PermissionHandlers } from "./handlers";

let handlers: PermissionHandlers | undefined;

/** The staff and permission handlers wired to this deployment's environment. Built on first use. */
export function permissionHandlers(): PermissionHandlers {
  if (!handlers) {
    const env = serverEnv();
    handlers = createPermissionHandlers({ db: tenantDb(), sessionSecret: env.SESSION_SECRET, appUrl: env.NEXT_PUBLIC_APP_URL });
  }
  return handlers;
}

/** Test helper: forget the wiring so the next call rebuilds it from the current environment. */
export function resetPermissionHandlers(): void {
  handlers = undefined;
}
