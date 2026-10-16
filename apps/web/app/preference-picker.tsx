"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { CALENDARS, LOCALES, type CalendarKind } from "@retail/i18n";

/** The language and calendar pickers (the languages come from the files in packages/i18n/messages). */
export function PreferencePicker({ locale, calendar }: { locale: string; calendar: CalendarKind }) {
  const t = useTranslations();
  const router = useRouter();

  async function save(choice: { language?: string; calendar?: string }) {
    await fetch("/api/preferences", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(choice) });
    router.refresh();
  }

  return (
    <div>
      <label>
        {t("language.label")}{" "}
        <select value={locale} onChange={(event) => void save({ language: event.target.value })}>
          {LOCALES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </select>
      </label>{" "}
      <label>
        {t("calendar.label")}{" "}
        <select value={calendar} onChange={(event) => void save({ calendar: event.target.value })}>
          {CALENDARS.map((c) => (
            <option key={c} value={c}>
              {t(`calendar.${c}`)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
