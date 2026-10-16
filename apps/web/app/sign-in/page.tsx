import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getLocale } from "next-intl/server";
import { devSignInEnabled } from "@retail/core";
import { getDeviceInfo, listDeviceStaff } from "@retail/db";
import { SignInFlow } from "./sign-in-flow";
import { deviceCookieName } from "@/lib/auth/cookie";
import { tenantDb } from "@/lib/db";
import { serverEnv } from "@/lib/env";
import { preferencesFromCookies } from "@/lib/preferences/resolve";
import { loadShellContext } from "@/lib/shell/context";
import { pickText } from "@retail/i18n";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ locked?: string }> }) {
  const signedIn = await loadShellContext();
  if (signedIn) redirect(signedIn.device ? "/pos" : "/");

  const env = serverEnv();
  const store = await cookies();
  const token = store.get(deviceCookieName(env.NEXT_PUBLIC_APP_URL))?.value;
  const peppers = { devicePepper: env.DEVICE_TOKEN_PEPPER };
  const device = token
    ? await tenantDb().device(async (tx) => {
        const info = await getDeviceInfo(tx, { deviceToken: token, ...peppers });
        return info ? { info, staff: await listDeviceStaff(tx, { deviceToken: token, ...peppers }) } : null;
      })
    : null;

  const locale = await getLocale();
  const { calendar } = preferencesFromCookies((name) => store.get(name)?.value);
  return (
    <SignInFlow
      locale={locale}
      calendar={calendar}
      locked={(await searchParams).locked === "idle"}
      showDev={devSignInEnabled(process.env)}
      device={device ? { name: device.info.deviceName, shop: pickText(device.info.tenantDisplayName, locale) } : null}
      staff={device ? device.staff.map((s) => ({ id: s.staffId, name: s.displayName, locked: s.locked })) : []}
    />
  );
}
