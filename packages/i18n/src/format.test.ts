import { describe, expect, it } from "vitest";
import { birr } from "@retail/core";
import { calendarDayInZone, formatBirr, formatDate, formatDateTime, formatTime } from "./format";
import { getMessages } from "./locales";

const en = getMessages("en");
const am = getMessages("am");
const ADDIS = "Africa/Addis_Ababa"; // UTC+3, no daylight saving

const options = (calendar: "gregorian" | "ethiopian", locale = "en", messages = en) => ({ locale, calendar, timeZone: ADDIS, messages });

describe("a shop's day is its own, not UTC's", () => {
  it("21:00 UTC on 15 October is already the 16th in Addis Ababa", () => {
    expect(calendarDayInZone(new Date("2026-10-15T20:59:59Z"), ADDIS)).toEqual({ year: 2026, month: 10, day: 15 });
    expect(calendarDayInZone(new Date("2026-10-15T21:00:00Z"), ADDIS)).toEqual({ year: 2026, month: 10, day: 16 });
    expect(calendarDayInZone(new Date("2026-10-15T21:00:00Z"), "UTC")).toEqual({ year: 2026, month: 10, day: 15 });
  });
  it("refuses an invalid date", () => {
    expect(() => calendarDayInZone(new Date("nope"), ADDIS)).toThrow(RangeError);
    expect(() => formatDate(new Date("nope"), options("gregorian"))).toThrow(RangeError);
    expect(() => formatTime(new Date("nope"), ADDIS)).toThrow(RangeError);
  });
});

describe("dates", () => {
  const moment = new Date("2026-10-16T11:05:00Z"); // 14:05 in Addis

  it("Gregorian is the plain choice, in the person's language, with Western digits", () => {
    expect(formatDate(moment, options("gregorian"))).toBe("Oct 16, 2026");
    const amharic = formatDate(moment, options("gregorian", "am", am));
    expect(amharic).toContain("2026");
    expect(amharic).toMatch(/\b16\b/);
    expect(amharic).not.toMatch(/[፩-፼]/); // no Ethiopic numerals
    expect(amharic).not.toContain("Oct");
  });

  it("Ethiopian uses the month names of the person's language", () => {
    expect(formatDate(moment, options("ethiopian"))).toBe("Tikimt 6, 2019");
    expect(formatDate(moment, options("ethiopian", "am", am))).toBe("ጥቅምት 6, 2019");
  });

  it("the Ethiopian New Year and the last, short month", () => {
    expect(formatDate(new Date("2026-09-10T12:00:00Z"), options("ethiopian"))).toBe("Pagume 5, 2018");
    expect(formatDate(new Date("2026-09-11T12:00:00Z"), options("ethiopian"))).toBe("Meskerem 1, 2019");
    expect(formatDate(new Date("2023-09-11T12:00:00Z"), options("ethiopian"))).toBe("Pagume 6, 2015");
  });

  it("the day changes at the shop's midnight for both calendars", () => {
    const before = new Date("2026-09-10T20:59:59Z"); // 23:59:59 on 10 September in Addis
    const after = new Date("2026-09-10T21:00:00Z"); // 00:00 on 11 September
    expect(formatDate(before, options("gregorian"))).toBe("Sep 10, 2026");
    expect(formatDate(after, options("gregorian"))).toBe("Sep 11, 2026");
    expect(formatDate(before, options("ethiopian"))).toBe("Pagume 5, 2018");
    expect(formatDate(after, options("ethiopian"))).toBe("Meskerem 1, 2019");
  });

  it("stored time is untouched: the same moment, two calendars", () => {
    const a = formatDate(moment, options("gregorian"));
    const b = formatDate(moment, options("ethiopian"));
    expect(a).not.toBe(b);
    expect(moment.toISOString()).toBe("2026-10-16T11:05:00.000Z");
  });

  it("names a missing month rather than printing 'undefined'", () => {
    expect(() => formatDate(moment, { ...options("ethiopian"), messages: {} })).toThrow(/no name for Ethiopian month 2/);
  });

  it("time is 24-hour in the shop's zone, and a date-time joins the two", () => {
    expect(formatTime(moment, ADDIS)).toBe("14:05");
    expect(formatTime(new Date("2026-10-15T21:00:00Z"), ADDIS)).toBe("00:00");
    expect(formatTime(moment, "UTC")).toBe("11:05");
    expect(formatDateTime(moment, options("gregorian"))).toBe("Oct 16, 2026 14:05");
    expect(formatDateTime(moment, options("ethiopian"))).toBe("Tikimt 6, 2019 14:05");
  });
});

describe("money", () => {
  it("Western digits and thousands separators; the currency word follows the language", () => {
    expect(formatBirr(birr(12450), en)).toBe("12,450 ETB");
    expect(formatBirr(birr(12450), am)).toBe("12,450 ብር");
    expect(formatBirr(1234567n, en)).toBe("12,345.67 ETB");
    expect(formatBirr(0n, am)).toBe("0 ብር");
    expect(formatBirr(-50n, en)).toBe("-0.50 ETB");
    expect(formatBirr(birr(12450), en, { decimals: "always" })).toBe("12,450.00 ETB");
    expect(formatBirr(birr(12450), am, { decimals: "always" })).toBe("12,450.00 ብር");
  });
  it("refuses to guess a currency word", () => {
    expect(() => formatBirr(100n, {})).toThrow(/currency label/);
  });
});
