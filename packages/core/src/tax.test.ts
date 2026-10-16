import { describe, expect, it } from "vitest";
import { birr } from "./money";
import { extractTax, summarizeTax } from "./tax";
import { randomInt, seededRandom } from "./testing";

// Test-only rate. Real rates come from platform configuration (see tax.ts).
const VAT = 1500; // 15%

describe("extractTax: 15% VAT out of a tax-inclusive price", () => {
  it("115 birr is 100 net + 15 tax", () => {
    expect(extractTax(birr(115), VAT)).toEqual({ net: birr(100), tax: birr(15) });
  });

  // gross santim -> expected tax santim, computed by hand as gross * 1500 / 11500, half away from zero
  it.each([
    [0n, 0n],
    [1n, 0n], // 0.130
    [3n, 0n], // 0.391
    [4n, 1n], // 0.522
    [5n, 1n], // 0.652
    [100n, 13n], // 13.043 (1 birr)
    [1_000n, 130n], // 130.43 (10 birr)
    [2_300n, 300n], // exact
    [5_750n, 750n], // exact
    [10_000n, 1_304n], // 1304.35 (100 birr)
    [12_345n, 1_610n], // 1610.22
    [11_500_000n, 1_500_000n], // exact (115,000 birr)
  ])("tax in %s santim is %s", (gross, expectedTax) => {
    const { net, tax } = extractTax(gross, VAT);
    expect(tax).toBe(expectedTax);
    expect(net).toBe(gross - expectedTax);
  });

  it("a phone sold at 18,500 birr carries 2,413.04 birr of VAT", () => {
    // 1,850,000 * 1500 / 11500 = 241,304.35 -> 241,304 santim
    expect(extractTax(birr(18_500), VAT)).toEqual({ net: 1_608_696n, tax: 241_304n });
  });

  it("a rate of zero (exempt or zero-rated) leaves the price untouched", () => {
    expect(extractTax(12_345n, 0)).toEqual({ net: 12_345n, tax: 0n });
  });

  it("rounds exact halves away from zero (20% rate: tax = gross / 6)", () => {
    expect(extractTax(3n, 2_000).tax).toBe(1n); // 0.5 -> 1
    expect(extractTax(9n, 2_000).tax).toBe(2n); // 1.5 -> 2
    expect(extractTax(-3n, 2_000).tax).toBe(-1n);
    expect(extractTax(-9n, 2_000).tax).toBe(-2n);
  });

  it("splits a return (negative gross) as the exact mirror of the sale", () => {
    expect(extractTax(-birr(115), VAT)).toEqual({ net: -birr(100), tax: -birr(15) });
    for (const gross of [1n, 5n, 100n, 12_345n, 987_654n]) {
      const sale = extractTax(gross, VAT);
      const refund = extractTax(-gross, VAT);
      expect(refund.tax).toBe(-sale.tax);
      expect(refund.net).toBe(-sale.net);
    }
  });

  it.each([1.5, -1, Number.NaN, 10_001, Number.POSITIVE_INFINITY])("rejects the rate %s", (rate) => {
    expect(() => extractTax(100n, rate)).toThrow(RangeError);
  });
});

describe("extractTax: properties over many amounts and rates", () => {
  const rates = [0, 500, 1_000, 1_500, 2_000, 10_000];

  it("net + tax === gross, tax is never negative or above gross, and tax never decreases as price rises", () => {
    // 180,000 cases: plain `if`s collect violations and we assert once at the end,
    // because one `expect` per case is far too slow at this volume.
    const violations: string[] = [];
    for (const rate of rates) {
      let previousTax = 0n;
      for (let gross = 0n; gross <= 30_000n; gross++) {
        const { net, tax } = extractTax(gross, rate);
        if (net + tax !== gross) violations.push(`rate ${rate} gross ${gross}: net + tax != gross`);
        if (tax < 0n || tax > gross) violations.push(`rate ${rate} gross ${gross}: tax ${tax} out of range`);
        if (tax < previousTax) violations.push(`rate ${rate} gross ${gross}: tax decreased`);
        previousTax = tax;
      }
    }
    expect(violations).toEqual([]);
  });

  it("is within half a santim of the exact rational tax (checked in integers, no floats)", () => {
    // exact tax = gross * rate / (10000 + rate); rounded tax may differ by at most 1/2.
    // Equivalent integer test: 2 * |tax * (10000 + rate) - gross * rate| <= (10000 + rate)
    const next = seededRandom(1500);
    for (let i = 0; i < 20_000; i++) {
      const rate = rates[randomInt(next, 0, rates.length - 1)] ?? 0;
      const gross = BigInt(randomInt(next, 0, 2 ** 31)) * BigInt(randomInt(next, 1, 5_000));
      const { tax } = extractTax(gross, rate);
      const r = BigInt(rate);
      const error = tax * (10_000n + r) - gross * r;
      expect((error < 0n ? -error : error) * 2n).toBeLessThanOrEqual(10_000n + r);
    }
  });
});

describe("summarizeTax: one extraction per rate group", () => {
  it("extracts on the group total, not per line (no accumulated rounding error)", () => {
    // Three 5-santim lines: per line each rounds to 1 santim of tax (total 3),
    // but the group total of 15 santim has 1.96 santim of tax, which is 2.
    const lines = [5n, 5n, 5n].map((gross) => ({ gross, rateBp: VAT }));
    const perLine = lines.reduce((sum, l) => sum + extractTax(l.gross, l.rateBp).tax, 0n);
    expect(perLine).toBe(3n);
    expect(summarizeTax(lines).tax).toBe(2n);
  });

  it("groups by rate, lowest rate first, and the totals add up", () => {
    const summary = summarizeTax([
      { gross: birr(115), rateBp: VAT },
      { gross: birr(50), rateBp: 0 },
      { gross: birr(230), rateBp: VAT },
    ]);
    expect(summary.groups).toEqual([
      { rateBp: 0, gross: birr(50), net: birr(50), tax: 0n },
      { rateBp: VAT, gross: birr(345), net: birr(300), tax: birr(45) },
    ]);
    expect(summary.gross).toBe(birr(395));
    expect(summary.net).toBe(birr(350));
    expect(summary.tax).toBe(birr(45));
  });

  it("returns zeros for an empty receipt", () => {
    expect(summarizeTax([])).toEqual({ groups: [], gross: 0n, net: 0n, tax: 0n });
  });

  it("a fully returned line cancels out", () => {
    const summary = summarizeTax([
      { gross: birr(115), rateBp: VAT },
      { gross: -birr(115), rateBp: VAT },
    ]);
    expect(summary.gross).toBe(0n);
    expect(summary.tax).toBe(0n);
  });

  it("net + tax === gross on random receipts", () => {
    const next = seededRandom(2026);
    for (let i = 0; i < 2_000; i++) {
      const lines = Array.from({ length: randomInt(next, 1, 12) }, () => ({
        gross: BigInt(randomInt(next, 1, 5_000_000)),
        rateBp: [0, VAT][randomInt(next, 0, 1)] ?? 0,
      }));
      const summary = summarizeTax(lines);
      expect(summary.net + summary.tax).toBe(summary.gross);
      for (const group of summary.groups) expect(group.net + group.tax).toBe(group.gross);
    }
  });

  it("rejects an invalid rate on any line", () => {
    expect(() => summarizeTax([{ gross: 100n, rateBp: -5 }])).toThrow(RangeError);
  });
});
