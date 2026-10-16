import { cookies } from "next/headers";
import { readSessionCookie, type AlertCategory } from "@retail/core";
import {
  SessionEndedError,
  countOpenAlerts,
  getEnabledModules,
  getMyDevice,
  getMyPermissions,
  getMyStaff,
  getMyTenant,
  type MyStaff,
  type MyTenant,
  type RlsContext,
} from "@retail/db";
import type { ModuleKey } from "@retail/core";
import { sessionCookieName } from "../auth/cookie";
import { tenantDb } from "../db";
import { serverEnv } from "../env";

/**
 * Who is signed in and what the shell should show them, loaded fresh on every page request
 * (nothing is cached: a suspended person or a changed permission shows on the very next page).
 * Returns null when nobody is signed in or the sign-in is over; the page then sends the person to sign in.
 */
export interface ShellContext {
  session: RlsContext;
  staff: MyStaff;
  tenant: MyTenant;
  modules: ModuleKey[];
  permissions: string[];
  /** The till, when this is a PIN sign-in on a connected device. */
  device: { id: string; name: string } | null;
  /** Open alerts per category; null when the person may not see alerts. */
  openAlerts: Record<AlertCategory, number> | null;
}

export async function loadShellContext(): Promise<ShellContext | null> {
  const env = serverEnv();
  const value = (await cookies()).get(sessionCookieName(env.NEXT_PUBLIC_APP_URL))?.value;
  if (!value) return null;
  const payload = await readSessionCookie(value, env.SESSION_SECRET, Math.floor(Date.now() / 1000));
  if (!payload) return null;
  const session: RlsContext = {
    tenantId: payload.tenantId,
    staffId: payload.staffId,
    sessionId: payload.sessionId,
    ...(payload.deviceId ? { deviceId: payload.deviceId } : {}),
  };
  try {
    return await tenantDb().rls(session, async (tx) => {
      const [staff, tenant, modules, permissions, device] = [await getMyStaff(tx), await getMyTenant(tx), await getEnabledModules(tx), await getMyPermissions(tx), await getMyDevice(tx)];
      if (!staff || !tenant) return null;
      return {
        session,
        staff,
        tenant,
        modules,
        permissions: [...permissions].sort(),
        device,
        openAlerts: permissions.has("alert:view") ? await countOpenAlerts(tx) : null,
      };
    });
  } catch (error) {
    if (error instanceof SessionEndedError) return null;
    throw error;
  }
}
