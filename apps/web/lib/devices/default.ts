import { tenantDb } from "../db";
import { serverEnv } from "../env";
import { createDeviceHandlers, type DeviceHandlers } from "./handlers";

let handlers: DeviceHandlers | undefined;

/** The device and PIN handlers wired to this deployment's environment. Built on first use, so importing a route needs no secrets. */
export function deviceHandlers(): DeviceHandlers {
  if (!handlers) {
    const env = serverEnv();
    handlers = createDeviceHandlers({
      db: tenantDb(),
      peppers: { devicePepper: env.DEVICE_TOKEN_PEPPER, pinPepper: env.PIN_PEPPER },
      sessionSecret: env.SESSION_SECRET,
      appUrl: env.NEXT_PUBLIC_APP_URL,
    });
  }
  return handlers;
}

/** Test helper: forget the wiring so the next call rebuilds it from the current environment. */
export function resetDeviceHandlers(): void {
  handlers = undefined;
}
