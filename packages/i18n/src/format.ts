import { formatMoney, gregorianToEthiopian, type CalendarDay, type FormatOptions, type Santim } from "@retail/core";
import { messageAt, type CalendarKind, type Messages } from "./locales";

/**
 * Showing dates and money (docs/SCREENS.md U7, PLAN.md D23). Dates are stored as Gregorian UTC;
 * what is shown follows the person's calendar. Digits are always Western (12,450, 2026), also in
 * Amharic: Ethiopic numerals are not used for money in practice.
 */

const WESTERN_DIGITS = "-u-nu-latn";

/** The Gregorian calendar day of a moment in a time zone (a shop's day is its own, not UTC's). */
export function calendarDayInZone(date: Date, timeZone: string): CalendarDay {
  if (Number.isNaN(date.getTime())) throw new RangeError("not a valid date");
  const parts = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(date);
  const value = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

export interface DateFormatOptions {
  locale: string;
  calendar: CalendarKind;
  /** e.g. "Africa/Addis_Ababa". */
  timeZone: string;
  /** Needed for the Ethiopian calendar: the month names of the language. */
  messages: Messages;
}

/** `Oct 16, 2026` (Gregorian) or `Tikimt 6, 2019` (Ethiopian), in the person's language. */
export function formatDate(date: Date, { locale, calendar, timeZone, messages }: DateFormatOptions): string {
  const day = calendarDayInZone(date, timeZone);
  if (calendar === "ethiopian") {
    const e = gregorianToEthiopian(day);
    const month = messageAt(messages, `calendar.ethiopian_month.${e.month}`);
    if (month === undefined) throw new Error(`no name for Ethiopian month ${e.month} in this language`);
    return `${month} ${e.day}, ${e.year}`;
  }
  return new Intl.DateTimeFormat(`${locale}-u-ca-gregory${WESTERN_DIGITS.slice(2)}`, { dateStyle: "medium", timeZone }).format(date);
}

/** `14:05`: 24-hour, in the shop's time zone. */
export function formatTime(date: Date, timeZone: string): string {
  if (Number.isNaN(date.getTime())) throw new RangeError("not a valid date");
  return new Intl.DateTimeFormat("en-GB-u-nu-latn", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}

export function formatDateTime(date: Date, options: DateFormatOptions): string {
  return `${formatDate(date, options)} ${formatTime(date, options.timeZone)}`;
}

/** `12,450 ETB`, `12,450.50 ETB` or `12,450 ብር`: Western digits, the currency word from the language's messages. Decimals only when there are santim, unless `decimals: "always"`. */
export function formatBirr(value: Santim, messages: Messages, options: FormatOptions = {}): string {
  const label = messageAt(messages, "common.currency.ETB");
  if (label === undefined) throw new Error("this language has no currency label for ETB");
  return formatMoney(value, label, options);
}
