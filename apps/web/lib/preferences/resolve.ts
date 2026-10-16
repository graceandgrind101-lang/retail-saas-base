import { isCalendar, isLocale, resolveCalendar, resolveLocale, type CalendarKind } from "@retail/i18n";
import { CALENDAR_COOKIE, LANGUAGE_COOKIE } from "./cookies";

/** The choices saved elsewhere than in this browser: the signed-in person's own, and the shop's defaults (settings). */
export interface SavedChoices {
  staffLanguage?: string | null;
  staffCalendar?: string | null;
  shopLanguage?: string | null;
  shopCalendar?: string | null;
}

/**
 * Which language and calendar to show a request. In order: what this browser asked for (cookie),
 * what the signed-in person saved on their own record, what the shop chose as its default, and
 * finally English and Gregorian (PLAN.md D22, D23). A value that is not offered is skipped.
 */
export function preferencesFromCookies(get: (name: string) => string | undefined, saved: SavedChoices = {}): { locale: string; calendar: CalendarKind } {
  const decode = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  };
  const cookieLanguage = decode(get(LANGUAGE_COOKIE));
  const cookieCalendar = decode(get(CALENDAR_COOKIE));
  return {
    locale: resolveLocale({ user: isLocale(cookieLanguage) ? cookieLanguage : saved.staffLanguage, shop: saved.shopLanguage }),
    calendar: resolveCalendar({ user: isCalendar(cookieCalendar) ? cookieCalendar : saved.staffCalendar, shop: saved.shopCalendar }),
  };
}
