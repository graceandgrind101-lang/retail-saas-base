import { isHttps } from "../auth/cookie";

/**
 * The language and calendar a browser asked for (Phase A task A11). These are display choices,
 * not secrets, so they are ordinary cookies a page may read; they are still only ever USED after
 * being checked against the languages and calendars that exist (core of the i18n package).
 */
export const LANGUAGE_COOKIE = "retail_lang";
export const CALENDAR_COOKIE = "retail_cal";
const ONE_YEAR_SECONDS = 365 * 24 * 3600;

function cookie(appUrl: string, name: string, value: string): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax", `Max-Age=${ONE_YEAR_SECONDS}`];
  if (isHttps(appUrl)) parts.push("Secure");
  return parts.join("; ");
}

export const languageCookieHeader = (appUrl: string, value: string): string => cookie(appUrl, LANGUAGE_COOKIE, value);
export const calendarCookieHeader = (appUrl: string, value: string): string => cookie(appUrl, CALENDAR_COOKIE, value);
