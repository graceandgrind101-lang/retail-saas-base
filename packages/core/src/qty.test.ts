import { describe, expect, it } from "vitest";
import { birr } from "./money";
import { formatQty, lineTotal, parseQty } from "./qty";

describe("parseQty / formatQty", () => {
  it.each([
    ["3", 3_000n],
    ["1.25", 1_250n],
    ["1.250", 1_250n],
    ["0.001", 1n],
    ["0", 0n],
    ["  2.5 ", 2_500n],
  ])("parses %j as %s", (input, expected) => {
    expect(parseQty(input)).toBe(expected);
  });

  it.each(["", "-1", "1.2345", ".5", "1.", "abc", "1,5", "1e2"])("rejects %j", (input) => {
    expect(parseQty(input)).toBeNull();
  });

  it.each([
    [3_000n, "3"],
    [1_250n, "1.25"],
    [1n, "0.001"],
    [0n, "0"],
    [10n, "0.01"],
    [123_456n, "123.456"],
    [-1_500n, "-1.5"],
  ])("formats %s as %j", (qty, expected) => {
    expect(formatQty(qty)).toBe(expected);
  });

  it("round-trips", () => {
    for (let q = 0n; q <= 5_000n; q += 7n) expect(parseQty(formatQty(q))).toBe(q);
  });
});

describe("lineTotal", () => {
  it("multiplies whole items exactly", () => {
    expect(lineTotal(birr(80), parseQty("3") ?? 0n)).toBe(birr(240));
  });

  it("prices weighed items: 1.250 kg at 80 birr/kg is 100 birr", () => {
    expect(lineTotal(birr(80), parseQty("1.250") ?? 0n)).toBe(birr(100));
  });

  it("rounds once, half away from zero", () => {
    expect(lineTotal(333n, 1_500n)).toBe(500n); // 499.5 -> 500
    expect(lineTotal(1n, 500n)).toBe(1n); // 0.5 -> 1
    expect(lineTotal(1n, 499n)).toBe(0n); // 0.499 -> 0
    expect(lineTotal(1n, 1n)).toBe(0n);
  });

  it("is zero for zero quantity or price", () => {
    expect(lineTotal(birr(80), 0n)).toBe(0n);
    expect(lineTotal(0n, 1_500n)).toBe(0n);
  });
});
