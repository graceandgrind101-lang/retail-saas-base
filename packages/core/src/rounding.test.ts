import { describe, expect, it } from "vitest";
import { divRound, roundToStep } from "./rounding";

describe("divRound (half away from zero)", () => {
  it.each([
    [4n, 2n, 2n], // exact
    [5n, 2n, 3n], // 2.5 -> 3
    [7n, 3n, 2n], // 2.33 -> 2
    [8n, 3n, 3n], // 2.67 -> 3
    [1n, 2n, 1n], // 0.5 -> 1
    [1n, 3n, 0n],
    [0n, 7n, 0n],
    [-5n, 2n, -3n], // -2.5 -> -3 (away from zero)
    [-7n, 3n, -2n],
    [-8n, 3n, -3n],
    [-1n, 2n, -1n],
    [5n, -2n, -3n], // negative denominator
    [-5n, -2n, 3n],
    [10n ** 18n + 1n, 10n ** 18n, 1n], // bigger than a double can hold exactly
  ])("divRound(%s, %s) = %s", (n, d, expected) => {
    expect(divRound(n, d)).toBe(expected);
  });

  it("throws on division by zero", () => {
    expect(() => divRound(1n, 0n)).toThrow(RangeError);
  });

  it("is odd-symmetric: divRound(-n, d) === -divRound(n, d)", () => {
    for (let n = 0n; n <= 200n; n++) {
      for (const d of [1n, 2n, 3n, 7n, 10n, 11500n]) {
        expect(divRound(-n, d)).toBe(-divRound(n, d));
      }
    }
  });
});

describe("roundToStep (cash rounding)", () => {
  it("leaves amounts already on the step unchanged", () => {
    expect(roundToStep(12350n, 50n)).toEqual({ rounded: 12350n, adjustment: 0n });
  });

  it("rounds to the nearest 0.50 birr and reports the adjustment", () => {
    expect(roundToStep(12374n, 50n)).toEqual({ rounded: 12350n, adjustment: -24n }); // 247.48 -> 247
    expect(roundToStep(12375n, 50n)).toEqual({ rounded: 12400n, adjustment: 25n }); // exactly half -> up
    expect(roundToStep(12376n, 50n)).toEqual({ rounded: 12400n, adjustment: 24n });
  });

  it("rounds to the nearest whole birr", () => {
    expect(roundToStep(10049n, 100n)).toEqual({ rounded: 10000n, adjustment: -49n });
    expect(roundToStep(10050n, 100n)).toEqual({ rounded: 10100n, adjustment: 50n });
  });

  it("a step of 1 santim changes nothing", () => {
    expect(roundToStep(12345n, 1n)).toEqual({ rounded: 12345n, adjustment: 0n });
  });

  it("works for negative amounts (refunds) symmetrically", () => {
    expect(roundToStep(-12375n, 50n)).toEqual({ rounded: -12400n, adjustment: -25n });
  });

  it("always satisfies rounded = amount + adjustment, a multiple of the step, within half a step", () => {
    for (const step of [50n, 100n]) {
      for (let amount = -300n; amount <= 300n; amount++) {
        const { rounded, adjustment } = roundToStep(amount, step);
        expect(rounded).toBe(amount + adjustment);
        expect(rounded % step).toBe(0n);
        expect((adjustment < 0n ? -adjustment : adjustment) * 2n).toBeLessThanOrEqual(step);
      }
    }
  });

  it("rejects a step that is not positive", () => {
    expect(() => roundToStep(100n, 0n)).toThrow(RangeError);
    expect(() => roundToStep(100n, -50n)).toThrow(RangeError);
  });
});
