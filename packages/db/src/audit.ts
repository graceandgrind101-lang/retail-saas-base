import { sql } from "drizzle-orm";
import type { RlsTransaction } from "./rls";

/**
 * Helpers for the audit log (migration 0002). Row changes in `app` are recorded by a database
 * trigger with no help from this code; use these for events that are not a row change:
 * sign-ins, failed PINs, exports, settings changes.
 */

/** `area.action`, lowercase, e.g. `auth.pin_failed`. `row.*` is reserved for the row triggers. */
const EVENT_KEY = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

export class InvalidAuditEventError extends Error {
  constructor(eventKey: string) {
    super(`Invalid audit event key "${eventKey}": use lowercase area.action, and never start with "row."`);
    this.name = "InvalidAuditEventError";
  }
}

export function isValidAuditEventKey(eventKey: string): boolean {
  return EVENT_KEY.test(eventKey) && !eventKey.startsWith("row.");
}

/**
 * Add an event to the current tenant's chain (the one named by the surrounding `db.rls()`).
 * Returns its sequence number. Never put secrets in `data`: it is readable by the shop owner.
 */
export async function recordAuditEvent(
  tx: RlsTransaction,
  eventKey: string,
  data?: Record<string, unknown>,
): Promise<number> {
  if (!isValidAuditEventKey(eventKey)) throw new InvalidAuditEventError(eventKey);
  const rows = await tx.execute<{ seq: string }>(
    sql`select audit.record_event(${eventKey}, ${data === undefined ? null : JSON.stringify(data)}::jsonb) as seq`,
  );
  return Number(rows[0]?.seq);
}

export interface ChainStatus {
  ok: boolean;
  /** Entries examined (all of them when ok). */
  checked: number;
  /** The first entry that is wrong, when not ok. */
  badSeq: number | null;
  reason: string | null;
}

/** Verify the current tenant's whole chain: no gaps, every link and every entry intact. */
export async function verifyOwnAuditChain(tx: RlsTransaction): Promise<ChainStatus> {
  const rows = await tx.execute<{ ok: boolean; checked: string; bad_seq: string | null; reason: string | null }>(
    sql`select ok, checked, bad_seq, reason from audit.verify_own_chain()`,
  );
  const row = rows[0];
  if (!row) throw new Error("audit.verify_own_chain returned nothing");
  return {
    ok: row.ok,
    checked: Number(row.checked),
    badSeq: row.bad_seq === null ? null : Number(row.bad_seq),
    reason: row.reason,
  };
}
