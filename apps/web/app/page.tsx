import { cookies } from "next/headers";
import { getLocale, getTranslations } from "next-intl/server";
import { formatDate, getMessages } from "@retail/i18n";
import { PreferencePicker } from "./preference-picker";
import { preferencesFromCookies } from "@/lib/preferences/resolve";

export default async function HomePage() {
  const t = await getTranslations("home");
  const locale = await getLocale();
  const store = await cookies();
  const { calendar } = preferencesFromCookies((name) => store.get(name)?.value);
  const today = formatDate(new Date(), { locale, calendar, timeZone: "Africa/Addis_Ababa", messages: getMessages(locale) });
  return (
    <main className="ui-page ui-stack">
      <h1>{t("title")}</h1>
      <p>{t("today", { date: today })}</p>
      <PreferencePicker locale={locale} calendar={calendar} />
    </main>
  );
}
