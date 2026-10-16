/**
 * The one rounding policy for all money math: integer division rounded **half away from
 * zero** (0.5 -> 1, -0.5 -> -1). Everything that divides money goes through here, so two
 * parts of the system can never round the same amount differently.
 */
export function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError("divRound: division by zero");

  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }

  const negative = n < 0n;
  const magnitude = negative ? -n : n;
  const quotient = magnitude / d;
  const remainder = magnitude % d;
  const rounded = remainder * 2n >= d ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/**
 * Round `amount` to the nearest multiple of `step` (cash rounding: 0.50 or 1 birr).
 * `adjustment` is what was added to reach the rounded value (positive = customer pays
 * more), and is stored separately on the sale so the Z report still balances.
 */
export function roundToStep(amount: bigint, step: bigint): { rounded: bigint; adjustment: bigint } {
  if (step <= 0n) throw new RangeError("roundToStep: step must be positive");
  const rounded = divRound(amount, step) * step;
  return { rounded, adjustment: rounded - amount };
}
