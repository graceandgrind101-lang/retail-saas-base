import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { getMessages } from "@retail/i18n";
import { preferencesFromCookies } from "../lib/preferences/resolve";
import { loadShellContext, savedChoices } from "../lib/shell/context";

// next-intl asks this once per request: which language, and its messages. Text lives only in
// packages/i18n/messages (docs/SCREENS.md §0.1). The person's cookie wins, then what they saved,
// then the shop's default setting, then English.
export default getRequestConfig(async () => {
  const store = await cookies();
  const ctx = await loadShellContext();
  const { locale } = preferencesFromCookies((name) => store.get(name)?.value, savedChoices(ctx));
  return { locale, messages: getMessages(locale), timeZone: ctx?.tenant.timezone ?? "Africa/Addis_Ababa" };
});
