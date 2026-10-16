import { resolveCalendar, resolveLocale, type CalendarKind } from "@retail/i18n";
import { CALENDAR_COOKIE, LANGUAGE_COOKIE } from "./cookies";

/**
 * Which language and calendar to show a request. Today only the browser's own choice counts; the
 * shop's default (a setting, task A14) and the person's saved choice slot in as `shop` and `user`.
 * English and Gregorian win when nothing valid is asked for (PLAN.md D22, D23).
 */
export function preferencesFromCookies(get: (name: string) => string | undefined): { locale: string; calendar: CalendarKind } {
  const decode = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  };
  return {
    locale: resolveLocale({ user: decode(get(LANGUAGE_COOKIE)) }),
    calendar: resolveCalendar({ user: decode(get(CALENDAR_COOKIE)) }),
  };
}
