import type { Santim } from "./money";
import { divRound } from "./rounding";

/**
 * Prices in this system are tax-inclusive (PLAN.md §8: Proclamation 813/2013), so tax is
 * *extracted* from a gross amount, never added on top.
 *
 * Rates are basis points (1500 = 15%) and are passed in. They are NOT constants here: they
 * live in platform configuration because they change (DATA_MODEL_B: `tax_rate_bp` is
 * snapshotted on every sale line).
 *
 * ROUNDING POLICY (to be confirmed with the Ministry of Revenues when e-invoicing is built,
 * PLAN.md §8 item 7): tax is extracted once per rate group on the group's total, not per
 * line, so rounding error does not accumulate across a long receipt. `net + tax === gross`
 * always holds exactly, because net is defined as `gross - tax`.
 */

const MAX_RATE_BP = 10_000; // 100%

function assertRate(rateBp: number): void {
  if (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > MAX_RATE_BP) {
    throw new RangeError(`tax rate must be a whole number of basis points from 0 to ${MAX_RATE_BP}, got ${rateBp}`);
  }
}

export interface TaxSplit {
  net: Santim;
  tax: Santim;
}

/** Split a tax-inclusive `gross` into net and tax. A negative gross (a return) splits symmetrically. */
export function extractTax(gross: Santim, rateBp: number): TaxSplit {
  assertRate(rateBp);
  const rate = BigInt(rateBp);
  const tax = divRound(gross * rate, 10_000n + rate);
  return { net: gross - tax, tax };
}

export interface TaxLine {
  /** Tax-inclusive amount of the line. */
  gross: Santim;
  rateBp: number;
}

export interface TaxGroup extends TaxSplit {
  rateBp: number;
  gross: Santim;
}

export interface TaxSummary {
  /** One entry per distinct rate, lowest rate first. */
  groups: TaxGroup[];
  gross: Santim;
  net: Santim;
  tax: Santim;
}

export function summarizeTax(lines: readonly TaxLine[]): TaxSummary {
  const grossByRate = new Map<number, Santim>();
  for (const line of lines) {
    assertRate(line.rateBp);
    grossByRate.set(line.rateBp, (grossByRate.get(line.rateBp) ?? 0n) + line.gross);
  }

  const groups: TaxGroup[] = [...grossByRate.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rateBp, gross]) => ({ rateBp, gross, ...extractTax(gross, rateBp) }));

  let gross = 0n;
  let net = 0n;
  let tax = 0n;
  for (const group of groups) {
    gross += group.gross;
    net += group.net;
    tax += group.tax;
  }
  return { groups, gross, net, tax };
}
