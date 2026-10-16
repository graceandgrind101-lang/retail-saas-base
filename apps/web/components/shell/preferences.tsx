"use client";

import { useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { CALENDARS, LOCALES, type CalendarKind } from "@retail/i18n";
import { THEME_PREFERENCES, isThemePreference, setThemePreference, type ThemePreference } from "@retail/ui";
import { postJson } from "../../lib/client/api";

// The theme lives on the <html> element (set by the pre-paint script); watch it rather than copy it.
function subscribeToTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme-preference"] });
  return () => observer.disconnect();
}
const currentTheme = (): ThemePreference => {
  const value = document.documentElement.getAttribute("data-theme-preference");
  return isThemePreference(value) ? value : "system";
};

/** Language, calendar and theme pickers. The first two are remembered for the person; the theme in this browser. */
export function Preferences({ locale, calendar }: { locale: string; calendar: CalendarKind }) {
  const t = useTranslations();
  const router = useRouter();
  const theme = useSyncExternalStore(subscribeToTheme, currentTheme, () => "system" as ThemePreference);

  async function save(choice: { language?: string; calendar?: string }) {
    await postJson("/api/preferences", choice);
    router.refresh();
  }

  return (
    <div className="shell-prefs">
      <label>
        {t("language.label")}
        <select value={locale} onChange={(event) => void save({ language: event.target.value })}>
          {LOCALES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("calendar.label")}
        <select value={calendar} onChange={(event) => void save({ calendar: event.target.value })}>
          {CALENDARS.map((c) => (
            <option key={c} value={c}>
              {t(`calendar.${c}`)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("shell.theme.label")}
        <select
          value={theme}
          onChange={(event) => {
            setThemePreference(event.target.value as ThemePreference);
          }}
        >
          {THEME_PREFERENCES.map((option) => (
            <option key={option} value={option}>
              {t(`shell.theme.${option}`)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
