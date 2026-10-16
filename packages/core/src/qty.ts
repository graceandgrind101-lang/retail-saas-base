import type { Santim } from "./money";
import { divRound } from "./rounding";

/**
 * Quantities are a `bigint` count of thousandths of a unit (database `numeric(14,3)`):
 * 1.250 kg is `1250n`. Whole items are multiples of 1000n. Integer math again, so a line
 * total never depends on floating point.
 */
export type QtyMilli = bigint;

export const QTY_SCALE: QtyMilli = 1000n;

const QTY_PATTERN = /^(\d+)(?:\.(\d{1,3}))?$/;

/** Parse a typed quantity ("3", "1.25", "0.001"). More than 3 decimals or negatives give `null`. */
export function parseQty(input: string): QtyMilli | null {
  const match = QTY_PATTERN.exec(input.trim());
  if (!match) return null;
  const whole = match[1] ?? "";
  const fraction = (match[2] ?? "").padEnd(3, "0");
  return BigInt(whole) * QTY_SCALE + BigInt(fraction);
}

/** `1250n` -> "1.25", `3000n` -> "3", `1n` -> "0.001". */
export function formatQty(qty: QtyMilli): string {
  const negative = qty < 0n;
  const magnitude = negative ? -qty : qty;
  const whole = magnitude / QTY_SCALE;
  const fraction = (magnitude % QTY_SCALE).toString().padStart(3, "0").replace(/0+$/, "");
  const text = fraction === "" ? whole.toString() : `${whole}.${fraction}`;
  return negative ? `-${text}` : text;
}

/** Price of `qty` units at `unitPrice` each, rounded once (half away from zero). */
export function lineTotal(unitPrice: Santim, qty: QtyMilli): Santim {
  return divRound(unitPrice * qty, QTY_SCALE);
}
