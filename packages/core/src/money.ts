/**
 * Money is a `bigint` count of santim (1 ETB = 100 santim), never a float (DATA_MODEL M6).
 * Database columns end in `_santim`. Plain `+`, `-` and comparison work on bigint; anything
 * that divides or multiplies by a fraction goes through rounding.ts so rounding is uniform.
 */
export type Santim = bigint;

export const SANTIM_PER_BIRR: Santim = 100n;

/** Whole birr to santim, e.g. `birr(115)` is `11500n`. For literals in code and tests. */
export function birr(wholeBirr: number): Santim {
  if (!Number.isSafeInteger(wholeBirr)) throw new RangeError(`birr(): expected a whole number, got ${wholeBirr}`);
  return BigInt(wholeBirr) * SANTIM_PER_BIRR;
}

export function sumSantim(values: Iterable<Santim>): Santim {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}

// "12", "12.5", "12.50", "1,234.50". Western digits only (docs/SCREENS.md U7).
const PLAIN_AMOUNT = /^(\d+)(?:\.(\d{1,2}))?$/;
const GROUPED_AMOUNT = /^(\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/;

/**
 * Parse an amount typed by a person (keypad or text) into santim. Strict by design:
 * more than two decimals, negatives, stray characters and misplaced thousands separators
 * return `null` instead of being silently rounded or guessed. Money input is never "fixed".
 */
export function parseBirr(input: string): Santim | null {
  const text = input.trim();
  const match = PLAIN_AMOUNT.exec(text) ?? GROUPED_AMOUNT.exec(text);
  if (!match) return null;

  const whole = (match[1] ?? "").replaceAll(",", "");
  const fraction = (match[2] ?? "").padEnd(2, "0");
  return BigInt(whole) * SANTIM_PER_BIRR + BigInt(fraction);
}

export interface FormatOptions {
  /**
   * "auto" (default) shows decimals only when there are santim: `12,450` / `12,450.50`.
   * "always" shows two decimals: `12,450.00`.
   */
  decimals?: "auto" | "always";
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** `12,450.50` with Western digits and comma thousands separators. No currency label. */
export function formatNumber(value: Santim, options: FormatOptions = {}): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const whole = magnitude / SANTIM_PER_BIRR;
  const fraction = magnitude % SANTIM_PER_BIRR;

  let text = groupThousands(whole.toString());
  if (fraction !== 0n || options.decimals === "always") {
    text += `.${fraction.toString().padStart(2, "0")}`;
  }
  return negative ? `-${text}` : text;
}

/**
 * `12,450 ETB` / `12,450 ብር`. The currency label comes from the message files
 * (docs/SCREENS.md U7), so it is passed in rather than hardcoded here.
 */
export function formatMoney(value: Santim, currencyLabel: string, options: FormatOptions = {}): string {
  return `${formatNumber(value, options)} ${currencyLabel}`;
}
