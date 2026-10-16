/**
 * The Ethiopian calendar (Phase A task A11, PLAN.md D23). Dates are stored as Gregorian UTC;
 * this converts a calendar DAY for display and for typing in. It has 13 months: twelve of 30
 * days and a last one (Pagume) of 5 days, or 6 in a leap year, which comes every 4th year
 * (years that leave 3 when divided by 4: 2015, 2019, 2023 ...). New Year is on 11 or 12 September.
 *
 * Pure integer arithmetic through the Julian Day Number, so it needs no Intl and no time zone:
 * to date a moment, first take its calendar day in the shop's time zone (core knows no zones).
 */

export interface CalendarDay {
  year: number;
  /** 1-12 for the Gregorian calendar, 1-13 for the Ethiopian. */
  month: number;
  day: number;
}

/** Julian Day Number of 1 Meskerem, year 1 (29 August 8 CE, Julian calendar). */
const ETHIOPIAN_EPOCH_JDN = 1724221;

const floorDiv = (a: number, b: number): number => Math.floor(a / b);
const mod = (a: number, b: number): number => a - b * Math.floor(a / b);

export function isGregorianLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function gregorianDaysInMonth(year: number, month: number): number {
  if (month === 2) return isGregorianLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function isValidGregorianDay(d: CalendarDay): boolean {
  return (
    Number.isSafeInteger(d.year) && Number.isSafeInteger(d.month) && Number.isSafeInteger(d.day) &&
    d.year >= 1 && d.year <= 9999 && d.month >= 1 && d.month <= 12 && d.day >= 1 && d.day <= gregorianDaysInMonth(d.year, d.month)
  );
}

export function isEthiopianLeapYear(year: number): boolean {
  return mod(year, 4) === 3;
}

export function ethiopianDaysInMonth(year: number, month: number): number {
  if (month === 13) return isEthiopianLeapYear(year) ? 6 : 5;
  return 30;
}

export function isValidEthiopianDay(d: CalendarDay): boolean {
  return (
    Number.isSafeInteger(d.year) && Number.isSafeInteger(d.month) && Number.isSafeInteger(d.day) &&
    d.year >= 1 && d.year <= 9999 && d.month >= 1 && d.month <= 13 && d.day >= 1 && d.day <= ethiopianDaysInMonth(d.year, d.month)
  );
}

function gregorianToJdn({ year, month, day }: CalendarDay): number {
  const a = floorDiv(14 - month, 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return day + floorDiv(153 * m + 2, 5) + 365 * y + floorDiv(y, 4) - floorDiv(y, 100) + floorDiv(y, 400) - 32045;
}

function jdnToGregorian(jdn: number): CalendarDay {
  const f = jdn + 1401 + floorDiv(floorDiv(4 * jdn + 274277, 146097) * 3, 4) - 38;
  const e = 4 * f + 3;
  const g = floorDiv(mod(e, 1461), 4);
  const h = 5 * g + 2;
  const day = floorDiv(mod(h, 153), 5) + 1;
  const month = mod(floorDiv(h, 153) + 2, 12) + 1;
  const year = floorDiv(e, 1461) - 4716 + floorDiv(12 + 2 - month, 12);
  return { year, month, day };
}

function ethiopianToJdn({ year, month, day }: CalendarDay): number {
  return ETHIOPIAN_EPOCH_JDN + 365 * (year - 1) + floorDiv(year, 4) + 30 * (month - 1) + day - 1;
}

function jdnToEthiopian(jdn: number): CalendarDay {
  const year = floorDiv(4 * (jdn - ETHIOPIAN_EPOCH_JDN) + 1463, 1461);
  const dayOfYear = jdn - ethiopianToJdn({ year, month: 1, day: 1 });
  return { year, month: floorDiv(dayOfYear, 30) + 1, day: (dayOfYear % 30) + 1 };
}

/** The Ethiopian date of a Gregorian calendar day. Throws on an impossible Gregorian date. */
export function gregorianToEthiopian(day: CalendarDay): CalendarDay {
  if (!isValidGregorianDay(day)) throw new RangeError(`not a Gregorian date: ${day.year}-${day.month}-${day.day}`);
  return jdnToEthiopian(gregorianToJdn(day));
}

/** The Gregorian calendar day of an Ethiopian date. Throws on an impossible Ethiopian date. */
export function ethiopianToGregorian(day: CalendarDay): CalendarDay {
  if (!isValidEthiopianDay(day)) throw new RangeError(`not an Ethiopian date: ${day.year}-${day.month}-${day.day}`);
  return jdnToGregorian(ethiopianToJdn(day));
}
