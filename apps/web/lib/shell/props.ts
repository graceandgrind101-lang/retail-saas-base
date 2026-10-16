import { cookies } from "next/headers";
import { getLocale, getTranslations } from "next-intl/server";
import { pickText } from "@retail/i18n";
import { preferencesFromCookies } from "../preferences/resolve";
import type { ShellContext } from "./context";

/** What both shells need that is not the menu: names in the person's language, alerts, display choices. */
export async function shellProps(ctx: ShellContext) {
  const locale = await getLocale();
  const store = await cookies();
  const { calendar } = preferencesFromCookies((name) => store.get(name)?.value);
  const t = await getTranslations("roles");
  const open = ctx.openAlerts ? Object.values(ctx.openAlerts).reduce((sum, n) => sum + n, 0) : null;
  return {
    locale,
    calendar,
    shopName: pickText(ctx.tenant.displayName, locale),
    staffName: ctx.staff.name,
    roleLabel: t.has(ctx.staff.roleKey) ? t(ctx.staff.roleKey) : ctx.staff.roleKey,
    alerts: open === null ? null : { open, hasFraud: (ctx.openAlerts?.fraud ?? 0) > 0 },
  };
}
