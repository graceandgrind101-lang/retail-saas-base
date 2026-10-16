import type { Sql } from "postgres";

/**
 * Audit anchoring (Phase A task A5, PLAN.md D28).
 *
 * The hash chain proves that nothing in the MIDDLE of a tenant's log was changed, but it cannot
 * show that the newest entries were deleted, or that someone with full database access rewrote
 * the whole history with freshly computed hashes. Copying the chain head OUTSIDE the database
 * can: the copy keeps the old hash, so a rewrite no longer matches it.
 *
 * Each run, for every tenant that has new entries since its last anchor:
 *   1. verify the whole chain AND every earlier anchor. If anything is wrong, anchor nothing and
 *      report it. Anchoring a corrupt chain would bless the damage.
 *   2. write {tenant, seq, hash} to the object store (write-once: never overwritten)
 *   3. record it in audit.anchors
 * Safe to run repeatedly; a run with nothing new does nothing.
 */

/** Where anchors are kept outside the database (Cloudflare R2 in production). */
export interface AnchorStore {
  /** Create the object. Must throw `AnchorExistsError` if the key is already taken: never overwrite. */
  put(key: string, body: string): Promise<void>;
  /** The stored body, or null when there is no such object. */
  get(key: string): Promise<string | null>;
}

export class AnchorExistsError extends Error {
  constructor(key: string) {
    super(`anchor object already exists: ${key}`);
    this.name = "AnchorExistsError";
  }
}

/** For tests and local runs. */
export class MemoryAnchorStore implements AnchorStore {
  readonly objects = new Map<string, string>();

  async put(key: string, body: string): Promise<void> {
    if (this.objects.has(key)) throw new AnchorExistsError(key);
    this.objects.set(key, body);
  }

  async get(key: string): Promise<string | null> {
    return this.objects.get(key) ?? null;
  }
}

export interface AnchorDocument {
  version: 1;
  tenantId: string;
  seq: number;
  hash: string;
  anchoredAt: string;
}

/** Zero-padded so keys sort in order in a bucket listing. */
export function anchorKey(tenantId: string, seq: number): string {
  return `anchors/${tenantId}/${String(seq).padStart(12, "0")}.json`;
}

export interface AnchorReport {
  anchored: { tenantId: string; seq: number; key: string }[];
  /** Tenants with nothing new since their last anchor. */
  unchanged: number;
  /** Tenants whose chain or earlier anchors did not verify. Anything here needs a human. */
  failures: { tenantId: string; reason: string }[];
}

interface HeadRow {
  tenant_id: string;
  head: string;
  anchored: string | null;
}

export interface AnchorOptions {
  /** Defaults to the current time. */
  now?: Date;
  /** Only these tenants. Defaults to every tenant that has log entries. */
  tenantIds?: string[];
}

export async function anchorAllTenants(sql: Sql, store: AnchorStore, options: AnchorOptions = {}): Promise<AnchorReport> {
  const now = options.now ?? new Date();
  const wanted = options.tenantIds ? new Set(options.tenantIds) : null;
  const report: AnchorReport = { anchored: [], unchanged: 0, failures: [] };

  const tenants = await sql<HeadRow[]>`
    select l.tenant_id, max(l.seq)::text as head,
           (select max(a.seq)::text from audit.anchors a where a.tenant_id = l.tenant_id) as anchored
    from audit.log l
    group by l.tenant_id
    order by l.tenant_id`;

  for (const { tenant_id: tenantId, head, anchored } of tenants) {
    if (wanted && !wanted.has(tenantId)) continue;
    if (anchored !== null && Number(anchored) >= Number(head)) {
      // Still check that old anchors have not been contradicted, even when nothing is new.
      const stale = await brokenAnchors(sql, tenantId);
      if (stale) report.failures.push({ tenantId, reason: stale });
      else report.unchanged += 1;
      continue;
    }

    const [chain] = await sql<{ ok: boolean; checked: string; bad_seq: string | null; reason: string | null }[]>`
      select ok, checked::text, bad_seq::text, reason from audit.verify_chain(${tenantId}::uuid)`;
    if (!chain?.ok) {
      report.failures.push({ tenantId, reason: `chain is broken at seq ${chain?.bad_seq}: ${chain?.reason}` });
      continue;
    }
    const earlier = await brokenAnchors(sql, tenantId);
    if (earlier) {
      report.failures.push({ tenantId, reason: earlier });
      continue;
    }

    // Anchor exactly the last entry that was verified, not whatever arrived since.
    const seq = Number(chain.checked);
    const [entry] = await sql<{ hash: string }[]>`select hash from audit.log where tenant_id = ${tenantId}::uuid and seq = ${seq}`;
    if (!entry) {
      report.failures.push({ tenantId, reason: `verified chain has no entry at seq ${seq}` });
      continue;
    }

    const key = anchorKey(tenantId, seq);
    const document: AnchorDocument = { version: 1, tenantId, seq, hash: entry.hash, anchoredAt: now.toISOString() };
    const body = JSON.stringify(document);

    try {
      await store.put(key, body);
    } catch (error) {
      if (!(error instanceof AnchorExistsError)) throw error;
      // A previous run stored it but died before recording it. Fine if it is the same anchor;
      // an object that differs means someone wrote a conflicting anchor, which is an alarm.
      const existing = await store.get(key);
      const same = existing !== null && sameAnchor(existing, document);
      if (!same) {
        report.failures.push({ tenantId, reason: `the object store already holds a DIFFERENT anchor at ${key}` });
        continue;
      }
    }

    await sql`insert into audit.anchors (tenant_id, seq, hash, object_key)
              values (${tenantId}::uuid, ${seq}, ${entry.hash}, ${key})
              on conflict (tenant_id, seq) do nothing`;
    report.anchored.push({ tenantId, seq, key });
  }

  return report;
}

function sameAnchor(stored: string, wanted: AnchorDocument): boolean {
  try {
    const parsed = JSON.parse(stored) as Partial<AnchorDocument>;
    return parsed.tenantId === wanted.tenantId && parsed.seq === wanted.seq && parsed.hash === wanted.hash;
  } catch {
    return false;
  }
}

/** A description of the first anchor the log contradicts, or null if all are consistent. */
async function brokenAnchors(sql: Sql, tenantId: string): Promise<string | null> {
  const [bad] = await sql<{ anchor_seq: string; reason: string }[]>`
    select anchor_seq::text, reason from audit.verify_anchors(${tenantId}::uuid) where not ok order by anchor_seq limit 1`;
  return bad ? `anchor at seq ${bad.anchor_seq} no longer matches the log: ${bad.reason}` : null;
}
