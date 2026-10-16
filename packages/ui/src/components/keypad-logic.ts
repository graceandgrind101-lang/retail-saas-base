/**
 * The rules of the amount keypad (the big numeric pad of the sale screen, PLAN.md §3), as a pure
 * function so they can be tested to the last key. The value is plain text such as `1250.5`, never
 * a number: typing "0" then "5" must give "5", and "1." must stay "1." until a digit follows.
 */
export interface KeypadRules {
  /** How many digits before the point (a sale never has more than a billion birr). */
  maxIntegerDigits: number;
  /** How many digits after the point: 2 for birr and santim, 0 for whole units. */
  decimals: number;
}

export const DEFAULT_KEYPAD_RULES: KeypadRules = { maxIntegerDigits: 9, decimals: 2 };

export type KeypadKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "00" | "." | "backspace" | "clear";

function pressDigit(value: string, digit: string, rules: KeypadRules): string {
  const point = value.indexOf(".");
  if (point !== -1) {
    return value.length - point - 1 < rules.decimals ? value + digit : value;
  }
  if (value === "0") return digit === "0" ? "0" : digit; // no leading zeros
  if (value === "" && digit === "0") return "0";
  return value.length < rules.maxIntegerDigits ? value + digit : value;
}

/** The value after one key press. Anything that would make an invalid amount is simply ignored. */
export function applyKey(value: string, key: string, rules: KeypadRules = DEFAULT_KEYPAD_RULES): string {
  if (!/^(\d*)(\.\d*)?$/.test(value)) return value; // never build on something that is not an amount
  switch (key) {
    case "backspace":
      return value.slice(0, -1);
    case "clear":
      return "";
    case ".":
      if (rules.decimals === 0 || value.includes(".")) return value;
      return value === "" ? "0." : `${value}.`;
    case "00":
      return pressDigit(pressDigit(value, "0", rules), "0", rules);
    default:
      return /^[0-9]$/.test(key) ? pressDigit(value, key, rules) : value;
  }
}
