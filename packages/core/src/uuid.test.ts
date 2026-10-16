import { afterEach, describe, expect, it, vi } from "vitest";
import { createUuidV7Generator, isUuid, isUuidV7, uuidV7Timestamp, uuidv7 } from "./uuid";

const T = 0x0123_4567_89ab; // a fixed timestamp, in ms
const zeros = () => new Uint8Array(10);
const ones = () => new Uint8Array(10).fill(0xff);

describe("UUIDv7 layout (RFC 9562)", () => {
  it("encodes the timestamp, version 7 and variant 10, with all-zero randomness", () => {
    const next = createUuidV7Generator({ now: () => T, random: zeros });
    expect(next()).toBe("01234567-89ab-7000-8000-000000000000");
  });

  it("fills the random bits from the entropy it is given", () => {
    const next = createUuidV7Generator({ now: () => T, random: ones });
    // counter starts at 0x7ff; variant forces the top two bits of rand_b to 10
    expect(next()).toBe("01234567-89ab-77ff-bfff-ffffffffffff");
  });

  it("round-trips the timestamp", () => {
    const next = createUuidV7Generator({ now: () => T, random: zeros });
    expect(uuidV7Timestamp(next())).toBe(T);
  });

  it("produces valid ids with the right version and variant characters", () => {
    for (let i = 0; i < 1_000; i++) {
      const id = uuidv7();
      expect(isUuidV7(id)).toBe(true);
      expect(id[14]).toBe("7");
      expect("89ab").toContain(id[19]);
    }
  });
});

describe("ordering", () => {
  it("counts up within one millisecond", () => {
    const next = createUuidV7Generator({ now: () => T, random: zeros });
    expect(next()).toBe("01234567-89ab-7000-8000-000000000000");
    expect(next()).toBe("01234567-89ab-7001-8000-000000000000");
    expect(next()).toBe("01234567-89ab-7002-8000-000000000000");
  });

  it("stays strictly increasing across 10,000 ids with a frozen clock, including counter overflow", () => {
    const next = createUuidV7Generator({ now: () => T, random: zeros });
    const ids = Array.from({ length: 10_000 }, () => next());
    for (let i = 1; i < ids.length; i++) {
      expect((ids[i] ?? "") > (ids[i - 1] ?? "")).toBe(true);
    }
    // the 12-bit counter (0..4095) is exhausted by id 4097, which moves to the next millisecond
    expect(uuidV7Timestamp(ids[4_095] ?? "")).toBe(T);
    expect(uuidV7Timestamp(ids[4_096] ?? "")).toBe(T + 1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never goes backwards when the clock does", () => {
    const clock = [T, T - 1_000, T - 5_000, T + 10];
    let i = 0;
    const next = createUuidV7Generator({ now: () => clock[i++] ?? T, random: zeros });
    const ids = [next(), next(), next(), next()];
    expect(ids.map(uuidV7Timestamp)).toEqual([T, T, T, T + 10]);
    for (let n = 1; n < ids.length; n++) expect((ids[n] ?? "") > (ids[n - 1] ?? "")).toBe(true);
  });

  it("orders by time when the clock moves forward", () => {
    let now = T;
    const next = createUuidV7Generator({ now: () => now });
    const first = next();
    now += 5;
    const second = next();
    expect(second > first).toBe(true);
    expect(uuidV7Timestamp(second) - uuidV7Timestamp(first)).toBe(5);
  });
});

describe("randomness and uniqueness", () => {
  it("gives 20,000 distinct ids from the real random source", () => {
    const ids = new Set(Array.from({ length: 20_000 }, () => uuidv7()));
    expect(ids.size).toBe(20_000);
  });

  it("the shared generator is time-stamped now and increasing", () => {
    const before = Date.now();
    const ids = Array.from({ length: 1_000 }, () => uuidv7());
    const after = Date.now();
    for (let i = 1; i < ids.length; i++) expect((ids[i] ?? "") > (ids[i - 1] ?? "")).toBe(true);
    const stamp = uuidV7Timestamp(ids[0] ?? "");
    expect(stamp).toBeGreaterThanOrEqual(before - 1);
    expect(stamp).toBeLessThanOrEqual(after + 5);
  });

  describe("without a secure random source", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("throws instead of falling back to Math.random", () => {
      vi.stubGlobal("crypto", undefined);
      expect(() => createUuidV7Generator()()).toThrow(/secure random/i);
    });
  });
});

describe("validation", () => {
  it("rejects timestamps outside the 48-bit range or not numbers", () => {
    for (const bad of [-1, 2 ** 48, Number.NaN, Number.POSITIVE_INFINITY]) {
      const next = createUuidV7Generator({ now: () => bad, random: zeros });
      expect(() => next()).toThrow(RangeError);
    }
  });

  it("isUuidV7 accepts v7 in any case and rejects everything else", () => {
    expect(isUuidV7("01234567-89ab-7000-8000-000000000000")).toBe(true);
    expect(isUuidV7("01234567-89AB-7000-8000-000000000000")).toBe(true);
    expect(isUuidV7("550e8400-e29b-41d4-a716-446655440000")).toBe(false); // v4
    expect(isUuidV7("01234567-89ab-7000-c000-000000000000")).toBe(false); // wrong variant
    expect(isUuidV7("01234567-89ab-7000-8000-00000000000")).toBe(false); // short
    expect(isUuidV7("not-a-uuid")).toBe(false);
    expect(isUuidV7("")).toBe(false);
  });

  it("uuidV7Timestamp throws for a non-v7 id", () => {
    expect(() => uuidV7Timestamp("550e8400-e29b-41d4-a716-446655440000")).toThrow(TypeError);
  });
});

describe("isUuid (any version)", () => {
  it("accepts well-formed v4 and v7 ids in any case", () => {
    expect(isUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isUuid("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
    expect(isUuid(uuidv7())).toBe(true);
  });

  it("rejects malformed values and values that could be injection attempts", () => {
    for (const bad of [
      "",
      "not-a-uuid",
      "550e8400e29b41d4a716446655440000", // no dashes
      "550e8400-e29b-41d4-a716-44665544000", // short
      "550e8400-e29b-41d4-a716-4466554400000", // long
      "550e8400-e29b-91d4-a716-446655440000", // version 9
      "550e8400-e29b-41d4-c716-446655440000", // bad variant
      "00000000-0000-0000-0000-000000000000", // nil
      "550e8400-e29b-41d4-a716-446655440000'; drop table x;--",
      " 550e8400-e29b-41d4-a716-446655440000",
    ]) {
      expect(isUuid(bad)).toBe(false);
    }
  });
});
