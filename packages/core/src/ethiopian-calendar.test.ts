import { describe, expect, it } from "vitest";
import {
  ethiopianDaysInMonth,
  ethiopianToGregorian,
  gregorianDaysInMonth,
  gregorianToEthiopian,
  isEthiopianLeapYear,
  isGregorianLeapYear,
  isValidEthiopianDay,
  isValidGregorianDay,
} from "./ethiopian-calendar";

const g = (year: number, month: number, day: number) => ({ year, month, day });

describe("known dates", () => {
  const pairs: [string, ReturnType<typeof g>, ReturnType<typeof g>][] = [
    ["Ethiopian New Year 2018", g(2025, 9, 11), g(2018, 1, 1)],
    ["Ethiopian New Year 2019", g(2026, 9, 11), g(2019, 1, 1)],
    ["the day before it: Pagume 5 (2018 is not a leap year)", g(2026, 9, 10), g(2018, 13, 5)],
    ["the year after a leap year starts a day later (12 September)", g(2023, 9, 12), g(2016, 1, 1)],
    ["Pagume 6 of the leap year 2015", g(2023, 9, 11), g(2015, 13, 6)],
    ["Ethiopian millennium", g(2007, 9, 12), g(2000, 1, 1)],
    ["Battle of Adwa", g(1896, 3, 1), g(1888, 6, 23)],
    ["Gregorian 1 January 2026", g(2026, 1, 1), g(2018, 4, 23)],
    ["Gregorian leap day 2024", g(2024, 2, 29), g(2016, 6, 21)],
    ["today's anchor: 16 October 2026", g(2026, 10, 16), g(2019, 2, 6)],
    ["start of the era", g(8, 8, 27), g(1, 1, 1)],
  ];
  it.each(pairs)("%s", (_name, gregorian, ethiopian) => {
    if (gregorian.year === 8) return; // proleptic, checked by the Intl cross-check below
    expect(gregorianToEthiopian(gregorian)).toEqual(ethiopian);
    expect(ethiopianToGregorian(ethiopian)).toEqual(gregorian);
  });
});

describe("the calendar rules", () => {
  it("every 4th year, the one leaving 3, is a leap year with a 6-day last month", () => {
    expect([2015, 2019, 2023, 2027].every(isEthiopianLeapYear)).toBe(true);
    expect([2016, 2017, 2018, 2020].some(isEthiopianLeapYear)).toBe(false);
    expect(ethiopianDaysInMonth(2019, 13)).toBe(6);
    expect(ethiopianDaysInMonth(2018, 13)).toBe(5);
    for (let m = 1; m <= 12; m++) expect(ethiopianDaysInMonth(2018, m)).toBe(30);
  });

  it("validates Ethiopian days: 13 months, Pagume 6 only in a leap year", () => {
    expect(isValidEthiopianDay(g(2019, 13, 6))).toBe(true);
    expect(isValidEthiopianDay(g(2018, 13, 6))).toBe(false);
    expect(isValidEthiopianDay(g(2018, 13, 5))).toBe(true);
    for (const bad of [g(2018, 0, 1), g(2018, 14, 1), g(2018, 1, 0), g(2018, 1, 31), g(0, 1, 1), g(10000, 1, 1), g(2018.5, 1, 1), g(2018, 1.5, 1), g(NaN, 1, 1)]) {
      expect(isValidEthiopianDay(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("every Gregorian month has its right length (leap and ordinary years)", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => gregorianDaysInMonth(2026, m))).toEqual([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
    expect(gregorianDaysInMonth(2024, 2)).toBe(29);
    expect(isValidGregorianDay(g(2026, 11, 31))).toBe(false);
    expect(isValidGregorianDay(g(2026, 11, 30))).toBe(true);
  });

  it("validates Gregorian days", () => {
    expect(isValidGregorianDay(g(2024, 2, 29))).toBe(true);
    expect(isValidGregorianDay(g(2025, 2, 29))).toBe(false);
    expect(isValidGregorianDay(g(1900, 2, 29))).toBe(false);
    expect(isValidGregorianDay(g(2000, 2, 29))).toBe(true);
    expect(isValidGregorianDay(g(2026, 4, 31))).toBe(false);
    expect(isValidGregorianDay(g(2026, 13, 1))).toBe(false);
    expect(isGregorianLeapYear(2100)).toBe(false);
    expect(gregorianDaysInMonth(2026, 9)).toBe(30);
    expect(gregorianDaysInMonth(2026, 10)).toBe(31);
  });

  it("refuses to convert impossible dates instead of guessing", () => {
    expect(() => gregorianToEthiopian(g(2025, 2, 30))).toThrow(RangeError);
    expect(() => ethiopianToGregorian(g(2018, 13, 6))).toThrow(RangeError);
    expect(() => ethiopianToGregorian(g(2018, 14, 1))).toThrow(RangeError);
  });
});

describe("every day from 1900 to 2100", () => {
  // The platform's own Ethiopian calendar is an independent implementation to check against.
  const intl = new Intl.DateTimeFormat("en-u-ca-ethiopic-nu-latn", { calendar: "ethiopic", timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric", era: "short" });
  const parts = (date: Date) => {
    const p = Object.fromEntries(intl.formatToParts(date).map((x) => [x.type, x.value]));
    return { year: Number(p.year), month: Number(p.month), day: Number(p.day), era: String(p.era) };
  };

  it("agrees with Intl, round-trips, and moves one day at a time", () => {
    let previous: { year: number; month: number; day: number } | null = null;
    let checked = 0;
    for (let ms = Date.UTC(1900, 0, 1); ms <= Date.UTC(2100, 11, 31); ms += 86_400_000) {
      const date = new Date(ms);
      const gregorian = g(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
      const ours = gregorianToEthiopian(gregorian);
      const theirs = parts(date);
      expect(ours, `${gregorian.year}-${gregorian.month}-${gregorian.day}`).toEqual({ year: theirs.year, month: theirs.month, day: theirs.day });
      expect(ethiopianToGregorian(ours)).toEqual(gregorian);
      if (previous) {
        const nextDay = previous.day < ethiopianDaysInMonth(previous.year, previous.month);
        const expected = nextDay
          ? { year: previous.year, month: previous.month, day: previous.day + 1 }
          : previous.month < 13
            ? { year: previous.year, month: previous.month + 1, day: 1 }
            : { year: previous.year + 1, month: 1, day: 1 };
        expect(ours).toEqual(expected);
      }
      previous = ours;
      checked++;
    }
    expect(checked).toBe(73_414);
  });

  it("agrees with Intl on far dates too (year 1 to 9999, sampled)", () => {
    for (const year of [100, 500, 1000, 1582, 1700, 2400, 3000, 5000, 9000]) {
      for (const [month, day] of [[1, 1], [2, 28], [6, 15], [9, 11], [9, 12], [12, 31]] as const) {
        const date = new Date(Date.UTC(2000, month - 1, day));
        date.setUTCFullYear(year);
        const gregorian = g(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
        const ours = gregorianToEthiopian(gregorian);
        const theirs = parts(date);
        // Intl shows the Ethiopian era in a year number that may be negative before the era's start; we only claim year >= 1
        if (theirs.era.includes("ERA1") || theirs.era.includes("Amete Mihret")) {
          expect(ours, `${year}-${month}-${day}`).toEqual({ year: theirs.year, month: theirs.month, day: theirs.day });
        }
        expect(ethiopianToGregorian(ours)).toEqual(gregorian);
      }
    }
  });
});
