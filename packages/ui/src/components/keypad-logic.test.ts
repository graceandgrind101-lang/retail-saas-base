import { describe, expect, it } from "vitest";
import { DEFAULT_KEYPAD_RULES, applyKey } from "./keypad-logic";

const type = (keys: string[], rules = DEFAULT_KEYPAD_RULES, start = "") => keys.reduce((value, key) => applyKey(value, key, rules), start);

describe("typing an amount", () => {
  it("builds numbers digit by digit", () => {
    expect(type(["1", "2", "5", "0"])).toBe("1250");
  });

  it("never keeps a leading zero", () => {
    expect(type(["0"])).toBe("0");
    expect(type(["0", "0", "0"])).toBe("0");
    expect(type(["0", "5"])).toBe("5");
    expect(type(["0", "0", "7", "3"])).toBe("73");
  });

  it("a point starts '0.' on an empty amount and stays after a number", () => {
    expect(type(["."])).toBe("0.");
    expect(type(["1", "2", "."])).toBe("12.");
    expect(type(["1", ".", "."])).toBe("1.");
  });

  it("stops at two digits after the point (santim)", () => {
    expect(type(["1", ".", "5", "0", "9"])).toBe("1.50");
    expect(type(["0", ".", "9", "9", "9"])).toBe("0.99");
  });

  it("zeros after the point are kept (they are santim)", () => {
    expect(type(["2", ".", "0", "5"])).toBe("2.05");
    expect(type(["2", ".", "0"])).toBe("2.0");
  });

  it("stops at the largest whole part allowed, but still takes decimals", () => {
    const nine = "123456789";
    expect(type(["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"])).toBe(nine);
    expect(type([".", "5"], DEFAULT_KEYPAD_RULES, nine)).toBe(`${nine}.5`);
  });

  it("whole-unit amounts have no point at all", () => {
    const whole = { maxIntegerDigits: 9, decimals: 0 };
    expect(type(["1", ".", "5"], whole)).toBe("15");
    expect(type(["."], whole)).toBe("");
  });

  it("the double zero key adds two zeros, within the limits", () => {
    expect(type(["5", "00"])).toBe("500");
    expect(type(["00"])).toBe("0");
    expect(type(["00", "5"])).toBe("5");
    expect(type(["1", ".", "00"])).toBe("1.00");
    expect(type(["1", ".", "5", "00"])).toBe("1.50");
    expect(type(["1", "2", "3", "4", "5", "6", "7", "8", "00"])).toBe("123456780");
  });

  it("delete removes the last key, clear removes everything", () => {
    expect(type(["1", "2", "3", "backspace"])).toBe("12");
    expect(type(["1", ".", "backspace"])).toBe("1");
    expect(type(["backspace"])).toBe("");
    expect(type(["0", ".", "backspace", "backspace", "backspace"])).toBe("");
    expect(type(["1", "2", "clear"])).toBe("");
  });

  it("ignores keys it does not know and refuses to build on something that is not an amount", () => {
    expect(type(["a"])).toBe("");
    expect(type(["1", "-", "2"])).toBe("12");
    expect(type(["12"])).toBe("");
    expect(applyKey("abc", "1")).toBe("abc");
    expect(applyKey("1.2.3", "4")).toBe("1.2.3");
    expect(applyKey("-5", "1")).toBe("-5");
  });

  it("whatever is pressed, the result is always a valid amount (500 random sequences)", () => {
    const keys = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "00", ".", "backspace", "clear", "x"];
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let run = 0; run < 500; run++) {
      let value = "";
      for (let i = 0; i < 40; i++) {
        value = applyKey(value, keys[next() % keys.length] as string);
        expect(value, `after ${i} presses in run ${run}`).toMatch(/^(|0|[1-9]\d{0,8})(\.\d{0,2})?$/);
        expect(value === "." || /^\.\d/.test(value), value).toBe(false);
      }
    }
  });
});
