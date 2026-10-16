import { describe, expect, it } from "vitest";
import { birr, formatMoney, formatNumber, parseBirr, sumSantim } from "./money";
import { randomInt, seededRandom } from "./testing";

describe("birr()", () => {
  it("converts whole birr to santim", () => {
    expect(birr(0)).toBe(0n);
    expect(birr(115)).toBe(11_500n);
    expect(birr(-5)).toBe(-500n);
  });

  it("refuses fractions and non-numbers instead of rounding", () => {
    expect(() => birr(1.5)).toThrow(RangeError);
    expect(() => birr(Number.NaN)).toThrow(RangeError);
    expect(() => birr(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("parseBirr (person-typed amounts)", () => {
  it.each([
    ["0", 0n],
    ["12", 1_200n],
    ["12.5", 1_250n],
    ["12.50", 1_250n],
    ["0.05", 5n],
    ["0.5", 50n],
    ["1,234.50", 123_450n],
    ["1,000", 100_000n],
    ["1234567.89", 123_456_789n],
    ["  15  ", 1_500n],
    ["007", 700n],
  ])("accepts %j as %s santim", (input, expected) => {
    expect(parseBirr(input)).toBe(expected);
  });

  it.each([
    "",
    " ",
    "-5", // negatives are not typed amounts
    "+5",
    "1.234", // never silently round money
    "1.",
    ".5",
    "1,23", // misplaced thousands separator
    "1,2345",
    ",100",
    "1,000,00",
    "12 000",
    "abc",
    "1e3",
    "NaN",
    "１２", // full-width digits: Western digits only
    "12 ETB",
    "1.2.3",
  ])("rejects %j", (input) => {
    expect(parseBirr(input)).toBeNull();
  });
});

describe("formatNumber / formatMoney", () => {
  it("shows decimals only when there are santim (auto)", () => {
    expect(formatNumber(1_245_000n)).toBe("12,450");
    expect(formatNumber(1_245_050n)).toBe("12,450.50");
    expect(formatNumber(1_245_005n)).toBe("12,450.05");
  });

  it("can always show two decimals", () => {
    expect(formatNumber(1_245_000n, { decimals: "always" })).toBe("12,450.00");
  });

  it("handles zero, tiny and huge amounts", () => {
    expect(formatNumber(0n)).toBe("0");
    expect(formatNumber(5n)).toBe("0.05");
    expect(formatNumber(100n)).toBe("1");
    expect(formatNumber(99_999n)).toBe("999.99");
    expect(formatNumber(100_000n)).toBe("1,000");
    expect(formatNumber(123_456_789_012n)).toBe("1,234,567,890.12");
    expect(formatNumber(10n ** 20n)).toBe("1,000,000,000,000,000,000");
  });

  it("formats negatives with a leading minus", () => {
    expect(formatNumber(-1_245_050n)).toBe("-12,450.50");
    expect(formatNumber(-5n)).toBe("-0.05");
  });

  it("adds the currency label supplied by the message files", () => {
    expect(formatMoney(1_245_000n, "ETB")).toBe("12,450 ETB");
    expect(formatMoney(1_245_050n, "ብር")).toBe("12,450.50 ብር");
  });
});

describe("round trips", () => {
  it("parseBirr(formatNumber(x)) === x for random non-negative amounts", () => {
    const next = seededRandom(20261016);
    for (let i = 0; i < 2_000; i++) {
      const value = BigInt(randomInt(next, 0, 2 ** 31)) * BigInt(randomInt(next, 1, 1_000));
      expect(parseBirr(formatNumber(value))).toBe(value);
      expect(parseBirr(formatNumber(value, { decimals: "always" }))).toBe(value);
    }
  });
});

describe("sumSantim", () => {
  it("adds exactly, with no float drift", () => {
    expect(sumSantim([])).toBe(0n);
    expect(sumSantim([10n, 20n, 30n])).toBe(60n);
    expect(sumSantim(Array.from({ length: 1_000 }, () => 1n))).toBe(1_000n);
  });
});
