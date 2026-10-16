import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InvalidAuditEventError, isValidAuditEventKey, recordAuditEvent, verifyOwnAuditChain } from "../src/audit";
import { createTenantDb, type RlsContext, type RlsTransaction, type TenantDb } from "../src/rls";
import { PG, adminSql, appSql, appUrl, createStaffSession, createTenant, expectPgError, newId, pgCode } from "./helpers";
import { createSecuredTable, dropTables } from "./probe-tables";

/**
 * The audit log (migration 0002): every row change recorded automatically, one hash chain
 * per tenant, append-only, and any tampering detectable. "Rogue DBA" tests deliberately
 * defeat the protections (as a database administrator could) to prove the chain still
 * exposes what was done.
 */

const admin: Sql = adminSql(4);
let db: TenantDb;

await dropTables(admin, "audit_probe");
await createSecuredTable(admin, "audit_probe", "label text, secret text, noise int, price bigint", {
  ignore: ["noise"],
  redact: ["secret"],
});

beforeAll(() => {
  db = createTenantDb(appUrl(), { max: 8 });
});
afterAll(async () => {
  await dropTables(admin, "audit_probe");
  await db.close();
  await admin.end();
});

// ── helpers ──────────────────────────────────────────────────────────────────
interface Entry {
  seq: number;
  event_key: string;
  actor_kind: string;
  actor_id: string | null;
  impersonator_id: string | null;
  session_id: string | null;
  device_id: string | null;
  pin_verification_id: string | null;
  table_name: string | null;
  row_id: string | null;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  txid: string;
  prev_hash: string;
  hash: string;
  occurred_at: Date;
}

const entriesOf = (tenant: string) =>
  admin<Entry[]>`
    select seq::int as seq, event_key, actor_kind, actor_id, impersonator_id, session_id, device_id,
           pin_verification_id, table_name, row_id, before_data, after_data, txid::text as txid,
           prev_hash, hash, occurred_at
    from audit.log where tenant_id = ${tenant} order by seq`;

const newTenant = (prefix: string) => createTenant(admin, `${prefix}-${randomBytes(4).toString("hex")}`);

const staffCtx = async (tenantId: string): Promise<RlsContext> => {
  const { staffId, sessionId } = await createStaffSession(admin, tenantId);
  return { tenantId, staffId, sessionId, deviceId: newId() };
};

type Row = { label?: string; secret?: string; noise?: number; price?: number };

async function insertRow(tenant: string, row: Row = {}, ctx: RlsContext = { tenantId: tenant }): Promise<string> {
  const id = newId();
  await db.rls(
    ctx,
    (tx) =>
      tx.execute(
        sql`insert into app.audit_probe (id, tenant_id, label, secret, noise, price)
            values (${id}, ${tenant}, ${row.label ?? "x"}, ${row.secret ?? null}, ${row.noise ?? 0}, ${row.price ?? null})`,
      ),
    { write: true },
  );
  return id;
}

const run = (tx: RlsTransaction, statement: ReturnType<typeof sql>) => tx.execute(statement);

async function chainOf(tenant: string) {
  const [row] = await admin<{ ok: boolean; checked: string; bad_seq: string | null; reason: string | null }[]>`
    select ok, checked::text, bad_seq::text, reason from audit.verify_chain(${tenant})`;
  return { ok: row?.ok, checked: Number(row?.checked), badSeq: row?.bad_seq === null ? null : Number(row?.bad_seq), reason: row?.reason };
}

async function anchorsOf(tenant: string) {
  return admin<{ anchor_seq: string; ok: boolean; reason: string | null }[]>`
    select anchor_seq::text, ok, reason from audit.verify_anchors(${tenant}) order by anchor_seq`;
}

/** Defeat the protections the way a database administrator could, then put them back. */
async function asRogueDba<T>(fn: () => Promise<T>): Promise<T> {
  await admin.unsafe("grant update, delete, truncate on audit.log to current_user");
  await admin.unsafe("alter table audit.log disable trigger audit_log_immutable_rows");
  try {
    return await fn();
  } finally {
    await admin.unsafe("alter table audit.log enable trigger audit_log_immutable_rows");
    await admin.unsafe("revoke update, delete, truncate on audit.log from current_user");
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── recording ────────────────────────────────────────────────────────────────
describe("every row change is recorded automatically", () => {
  it("insert: whole row in after_data, nothing in before_data, who/where recorded", async () => {
    const tenant = await newTenant("rec-ins");
    const ctx = await staffCtx(tenant); // creating a real staff member and session is itself audited
    const baseline = (await entriesOf(tenant)).length;
    const rowId = await insertRow(tenant, { label: "iPhone 15", price: 200_000 }, ctx);

    const entries = await entriesOf(tenant);
    expect(entries).toHaveLength(baseline + 1);
    const entry = entries.at(-1);
    expect(entry).toMatchObject({
      seq: baseline + 1,
      event_key: "row.insert",
      actor_kind: "staff",
      actor_id: ctx.staffId,
      session_id: ctx.sessionId,
      device_id: ctx.deviceId,
      impersonator_id: null,
      table_name: "app.audit_probe",
      row_id: rowId,
      before_data: null,
    });
    expect(entry?.after_data).toMatchObject({ id: rowId, tenant_id: tenant, label: "iPhone 15", price: 200_000 });
    expect(Number(entry?.txid)).toBeGreaterThan(0);
  });

  it("update: only the columns that changed, old and new values, never updated_at", async () => {
    const tenant = await newTenant("rec-upd");
    const id = await insertRow(tenant, { label: "before", price: 100 });
    await db.rls({ tenantId: tenant }, (tx) => run(tx, sql`update app.audit_probe set label = 'after', price = 100 where id = ${id}`), { write: true });
    const entries = await entriesOf(tenant);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ event_key: "row.update", before_data: { label: "before" }, after_data: { label: "after" } });
    expect(entries[1]?.after_data).not.toHaveProperty("price"); // set to the same value: not a change
    expect(entries[1]?.after_data).not.toHaveProperty("updated_at");
  });

  it("an update that changes only an ignored (noise) column is not recorded at all", async () => {
    const tenant = await newTenant("rec-noise");
    const id = await insertRow(tenant, { noise: 1 });
    await db.rls({ tenantId: tenant }, (tx) => run(tx, sql`update app.audit_probe set noise = 2 where id = ${id}`), { write: true });
    expect(await entriesOf(tenant)).toHaveLength(1);
  });

  it("when noise and a real column change together, only the real column is recorded", async () => {
    const tenant = await newTenant("rec-mixed");
    const id = await insertRow(tenant, { noise: 1, label: "a" });
    await db.rls({ tenantId: tenant }, (tx) => run(tx, sql`update app.audit_probe set noise = 2, label = 'b' where id = ${id}`), { write: true });
    const last = (await entriesOf(tenant)).at(-1);
    expect(last?.before_data).toEqual({ label: "a" });
    expect(last?.after_data).toEqual({ label: "b" });
  });

  it("delete: the whole old row in before_data", async () => {
    const tenant = await newTenant("rec-del");
    const id = await insertRow(tenant, { label: "gone", price: 5 });
    await db.rls({ tenantId: tenant }, (tx) => run(tx, sql`delete from app.audit_probe where id = ${id}`), { write: true });
    const last = (await entriesOf(tenant)).at(-1);
    expect(last).toMatchObject({ event_key: "row.delete", after_data: null, row_id: id });
    expect(last?.before_data).toMatchObject({ label: "gone", price: 5 });
  });

  it("one statement that changes three rows leaves three consecutive entries", async () => {
    const tenant = await newTenant("rec-multi");
    for (let i = 0; i < 3; i++) await insertRow(tenant, { label: "same" });
    await db.rls({ tenantId: tenant }, (tx) => run(tx, sql`update app.audit_probe set label = 'changed'`), { write: true });
    const entries = await entriesOf(tenant);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(entries.slice(3).every((e) => e.event_key === "row.update")).toBe(true);
  });

  it("a rolled-back transaction leaves no entry and no gap", async () => {
    const tenant = await newTenant("rec-rollback");
    await insertRow(tenant);
    await expect(
      db.rls({ tenantId: tenant }, async (tx) => {
        await run(tx, sql`insert into app.audit_probe (id, tenant_id, label) values (${newId()}, ${tenant}, 'ghost')`);
        throw new Error("abort");
      }, { write: true }),
    ).rejects.toThrow("abort");
    await insertRow(tenant);
    expect((await entriesOf(tenant)).map((e) => e.seq)).toEqual([1, 2]);
    expect((await chainOf(tenant)).ok).toBe(true);
  });

  it("changes made with no request context are recorded as the system", async () => {
    const tenant = await newTenant("rec-system");
    await admin`insert into app.audit_probe (id, tenant_id, label) values (${newId()}, ${tenant}, 'by admin')`;
    expect((await entriesOf(tenant))[0]).toMatchObject({ actor_kind: "system", actor_id: null });
  });

  it("a platform admin acting inside a shop is recorded as such, with the impersonation", async () => {
    const tenant = await newTenant("rec-imp");
    const impersonatorId = newId();
    await insertRow(tenant, {}, { tenantId: tenant, impersonatorId });
    expect((await entriesOf(tenant))[0]).toMatchObject({
      actor_kind: "platform_admin",
      actor_id: impersonatorId,
      impersonator_id: impersonatorId,
    });
  });

  it("settles the iPhone dispute: price 200,000 became 20,000, by whom, approved with which PIN", async () => {
    const tenant = await newTenant("rec-dispute");
    const seller = await staffCtx(tenant);
    const id = await insertRow(tenant, { label: "iPhone 15", price: 200_000 }, seller);

    const approver = { ...(await staffCtx(tenant)), pinVerificationId: newId() };
    await db.rls(approver, (tx) => run(tx, sql`update app.audit_probe set price = 20000 where id = ${id}`), { write: true });

    // The shop owner reads the history of that one row, through the same wrapper the app uses.
    const history = await db.rls({ tenantId: tenant }, (tx) =>
      tx.execute<{ seq: string; actor_id: string; pin: string | null; before_price: string | null; after_price: string | null }>(
        sql`select seq::text, actor_id, pin_verification_id as pin,
                   before_data->>'price' as before_price, after_data->>'price' as after_price
            from audit.log where row_id = ${id} order by seq`,
      ),
    );
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({
      actor_id: approver.staffId,
      pin: approver.pinVerificationId,
      before_price: "200000",
      after_price: "20000",
    });
  });
});

describe("secrets never reach the log", () => {
  it("a redacted column shows as [redacted] on insert and update, and its value appears nowhere", async () => {
    const tenant = await newTenant("rec-redact");
    const first = "s3cr3t-first-value-9f2";
    const second = "s3cr3t-second-value-7b1";
    const id = await insertRow(tenant, { secret: first });
    await db.rls({ tenantId: tenant }, (tx) => run(tx, sql`update app.audit_probe set secret = ${second} where id = ${id}`), { write: true });

    const entries = await entriesOf(tenant);
    expect(entries[0]?.after_data).toMatchObject({ secret: "[redacted]" });
    expect(entries[1]?.before_data).toEqual({ secret: "[redacted]" });
    expect(entries[1]?.after_data).toEqual({ secret: "[redacted]" });

    const [leak] = await admin<{ n: number }[]>`
      select count(*)::int as n from audit.log
      where tenant_id = ${tenant} and (before_data::text like '%s3cr3t%' or after_data::text like '%s3cr3t%')`;
    expect(leak?.n).toBe(0);
  });

  it("secure_tenant_table refuses a column list with a typo instead of silently auditing the wrong thing", async () => {
    await createSecuredTable(admin, "audit_typo", "label text");
    try {
      await expectPgError(
        Promise.resolve(admin.unsafe("select private.secure_tenant_table('app.audit_typo', array['lable']::text[], array[]::text[])")),
        "P0001",
      );
    } finally {
      await dropTables(admin, "audit_typo");
    }
  });
});

// ── chains ───────────────────────────────────────────────────────────────────
describe("one chain per tenant", () => {
  it("each tenant's chain starts at 1 and links to its own genesis hash", async () => {
    const a = await newTenant("chain-a");
    const b = await newTenant("chain-b");
    await insertRow(a);
    await insertRow(b);
    await insertRow(a);
    await insertRow(b);

    const ea = await entriesOf(a);
    const eb = await entriesOf(b);
    expect(ea.map((e) => e.seq)).toEqual([1, 2]);
    expect(eb.map((e) => e.seq)).toEqual([1, 2]);

    const genesis = async (t: string) => (await admin<{ g: string }[]>`select audit.genesis_hash(${t}) as g`)[0]?.g;
    expect(ea[0]?.prev_hash).toBe(await genesis(a));
    expect(eb[0]?.prev_hash).toBe(await genesis(b));
    expect(await genesis(a)).not.toBe(await genesis(b));
    expect(ea[1]?.prev_hash).toBe(ea[0]?.hash);
    expect((await chainOf(a)).ok).toBe(true);
    expect((await chainOf(b)).ok).toBe(true);
  });
});

describe("hashing is pinned to a known answer", () => {
  // If this fails, how an entry is hashed changed: either someone edited audit.compute_hash,
  // or a new Postgres prints jsonb differently. Either way every existing chain would stop
  // verifying, so this must be handled with a migration, never by editing the expected values.
  const tenant = "018f0000-0000-7000-8000-000000000001";
  const genesis = "a0e7a731cf0c1d196dfebd2cea40285ee93e2f91944fffa9e628808b9cd47848";
  const canonical =
    '{"at": 1792152000123456, "pin": "018f0000-0000-7000-8000-0000000000c1", "row": "018f0000-0000-7000-8000-0000000000d1", "seq": 1, "txid": 12345, "actor": "018f0000-0000-7000-8000-0000000000a1", "after": {"price": 20000}, "event": "row.update", "table": "app.products", "before": {"price": 200000}, "device": null, "tenant": "018f0000-0000-7000-8000-000000000001", "session": "018f0000-0000-7000-8000-0000000000b1", "device_at": null, "actor_kind": "staff", "impersonator": null}';
  const expectedHash = "b217e315c173edd89b1f236136731c19d1817da9b72e473c23dc04d462f9330d";

  it("the genesis hash for a fixed tenant", async () => {
    const [row] = await admin<{ g: string }[]>`select audit.genesis_hash(${tenant}) as g`;
    expect(row?.g).toBe(genesis);
    expect(createHash("sha256").update(`retail-audit-genesis:${tenant}`).digest("hex")).toBe(genesis);
  });

  it("the entry hash for fixed inputs, which an independent SHA-256 over the canonical text reproduces", async () => {
    const [row] = await admin<{ h: string }[]>`
      select audit.compute_hash(
        ${genesis}, ${tenant}::uuid, 1, timestamptz '2026-10-16 12:00:00.123456+00', 'row.update', 'staff',
        '018f0000-0000-7000-8000-0000000000a1'::uuid, null, '018f0000-0000-7000-8000-0000000000b1'::uuid, null,
        '018f0000-0000-7000-8000-0000000000c1'::uuid, 'app.products', '018f0000-0000-7000-8000-0000000000d1'::uuid,
        ${admin.json({ price: 200000 })}, ${admin.json({ price: 20000 })}, 12345, null) as h`;
    expect(row?.h).toBe(expectedHash);
    expect(createHash("sha256").update(`${genesis}|${canonical}`).digest("hex")).toBe(expectedHash);
  });
});

// ── access ───────────────────────────────────────────────────────────────────
describe("a shop's own session", () => {
  let tenantA = "";
  let tenantB = "";

  beforeAll(async () => {
    tenantA = await newTenant("acc-a");
    tenantB = await newTenant("acc-b");
    await insertRow(tenantA);
    await insertRow(tenantA);
    await insertRow(tenantB);
  });

  it("reads its own entries and none of another shop's", async () => {
    const own = await db.rls({ tenantId: tenantA }, (tx) => tx.execute<{ tenant_id: string }>(sql`select tenant_id from audit.log`));
    expect(own).toHaveLength(2);
    expect(own.every((r) => r.tenant_id === tenantA)).toBe(true);
    const other = await db.rls({ tenantId: tenantA }, (tx) => tx.execute(sql`select * from audit.log where tenant_id = ${tenantB}`));
    expect(other).toHaveLength(0);
  });

  it("sees nothing without a tenant context", async () => {
    const app = appSql(1);
    try {
      const rows = await app.begin(async (tx) => {
        await tx`set local role authenticated`;
        return tx<{ n: number }[]>`select count(*)::int as n from audit.log`;
      });
      expect(rows[0]?.n).toBe(0);
    } finally {
      await app.end();
    }
  });

  it.each([
    ["insert", "insert into audit.log (tenant_id, seq, occurred_at, event_key, actor_kind, txid, prev_hash, hash) values ($1, 999, now(), 'a.b', 'system', 1, repeat('0', 64), repeat('0', 64))"],
    ["update", "update audit.log set event_key = 'x.y' where tenant_id = $1"],
    ["delete", "delete from audit.log where tenant_id = $1"],
    ["truncate", "truncate audit.log"],
    ["read anchors", "select * from audit.anchors"],
    ["call append", "select audit.append($1::uuid, 'a.b', null, null, null, null)"],
    ["call record_event_for", "select audit.record_event_for($1::uuid, 'a.b')"],
    ["call verify_chain", "select * from audit.verify_chain($1::uuid)"],
    ["call verify_anchors", "select * from audit.verify_anchors($1::uuid)"],
    ["call compute_hash", "select audit.compute_hash(repeat('0', 64), $1::uuid, 1, now(), 'a.b', 'system', null, null, null, null, null, null, null, null, null, 1, null)"],
  ])("cannot %s", async (_label, statement) => {
    const app = appSql(1);
    try {
      await expectPgError(
        Promise.resolve(
          app.begin(async (tx) => {
            await tx`set local role authenticated`;
            await tx`select set_config('app.tenant_id', ${tenantA}, true)`;
            return tx.unsafe(statement, statement.includes("$1") ? [tenantA] : []);
          }),
        ),
        PG.permissionDenied,
      );
    } finally {
      await app.end();
    }
  });

  it("can record its own events, always into its own chain", async () => {
    const tenant = await newTenant("acc-event");
    const ctx = await staffCtx(tenant);
    const baseline = (await entriesOf(tenant)).length;
    const seq = await db.rls(ctx, (tx) => recordAuditEvent(tx, "auth.pin_failed", { attempts: 3 }));
    expect(seq).toBe(baseline + 1);
    const entry = (await entriesOf(tenant)).at(-1);
    expect(entry).toMatchObject({ event_key: "auth.pin_failed", table_name: null, row_id: null, before_data: null, after_data: { attempts: 3 } });
  });

  it("cannot record an event without a tenant context", async () => {
    const app = appSql(1);
    try {
      await expectPgError(
        Promise.resolve(app.begin(async (tx) => { await tx`set local role authenticated`; return tx`select audit.record_event('a.b')`; })),
        PG.permissionDenied,
      );
    } finally {
      await app.end();
    }
  });

  it("cannot forge a row event or use a malformed key (the database refuses, not just the helper)", async () => {
    const tenant = await newTenant("acc-forge");
    await expectPgError(db.rls({ tenantId: tenant }, (tx) => run(tx, sql`select audit.record_event('row.insert')`)), PG.checkViolation);
    await expectPgError(db.rls({ tenantId: tenant }, (tx) => run(tx, sql`select audit.record_event('Bad Key')`)), PG.checkViolation);
    expect(await entriesOf(tenant)).toHaveLength(0);
  });

  it("the helper rejects bad event keys before touching the database", async () => {
    for (const bad of ["", "nodot", "Row.insert", "row.insert", "a.b c", "auth.", ".x", "a..b"]) {
      expect(isValidAuditEventKey(bad), bad).toBe(false);
    }
    for (const good of ["auth.pin_failed", "settings.changed", "export.downloaded", "a.b.c"]) {
      expect(isValidAuditEventKey(good), good).toBe(true);
    }
    const tenant = await newTenant("acc-helper");
    await expect(db.rls({ tenantId: tenant }, (tx) => recordAuditEvent(tx, "row.insert"))).rejects.toThrow(InvalidAuditEventError);
  });

  it("can verify its own chain", async () => {
    const status = await db.rls({ tenantId: tenantA }, (tx) => verifyOwnAuditChain(tx));
    expect(status).toEqual({ ok: true, checked: 2, badSeq: null, reason: null });
  });
});

// ── append-only ──────────────────────────────────────────────────────────────
describe("append-only, even against the database owner", () => {
  let tenant = "";

  beforeAll(async () => {
    tenant = await newTenant("only");
    await insertRow(tenant);
    await admin`insert into audit.anchors (tenant_id, seq, hash, object_key)
                select tenant_id, seq, hash, 'test/key' from audit.log where tenant_id = ${tenant} and seq = 1`;
  });

  it.each([
    ["update audit.log", () => admin`update audit.log set event_key = 'x.y' where tenant_id = ${tenant}`],
    ["delete from audit.log", () => admin`delete from audit.log where tenant_id = ${tenant}`],
    ["truncate audit.log", () => admin.unsafe("truncate audit.log")],
    ["update audit.anchors", () => admin`update audit.anchors set object_key = 'x' where tenant_id = ${tenant}`],
    ["delete from audit.anchors", () => admin`delete from audit.anchors where tenant_id = ${tenant}`],
    ["truncate audit.anchors", () => admin.unsafe("truncate audit.anchors")],
  ])("the owner cannot %s: the privilege is revoked", async (_label, statement) => {
    await expectPgError(Promise.resolve(statement()), PG.permissionDenied);
  });

  it("the triggers still refuse after the privileges are handed back (rogue administrator)", async () => {
    await admin.unsafe("grant update, delete, truncate on audit.log, audit.anchors to current_user");
    try {
      for (const statement of [
        () => admin`update audit.log set event_key = 'x.y' where tenant_id = ${tenant}`,
        () => admin`delete from audit.log where tenant_id = ${tenant}`,
        () => admin.unsafe("truncate audit.log"),
        () => admin`update audit.anchors set object_key = 'x' where tenant_id = ${tenant}`,
        () => admin.unsafe("truncate audit.anchors"),
      ]) {
        let message = "";
        try {
          await statement();
        } catch (error) {
          message = (error as Error).message;
          expect(pgCode(error)).toBe(PG.permissionDenied);
        }
        expect(message).toContain("append-only");
      }
    } finally {
      await admin.unsafe("revoke update, delete, truncate on audit.log, audit.anchors from current_user");
    }
  });
});

// ── tamper detection ─────────────────────────────────────────────────────────
describe("tampering is detected (a rogue administrator defeats the protections on purpose)", () => {
  async function chainWith(prefix: string, entries = 10) {
    const tenant = await newTenant(prefix);
    for (let i = 0; i < entries; i++) await insertRow(tenant, { label: `row ${i}` });
    expect(await chainOf(tenant)).toMatchObject({ ok: true, checked: entries });
    return tenant;
  }

  async function anchorHead(tenant: string, seq: number) {
    await admin`insert into audit.anchors (tenant_id, seq, hash, object_key)
                select tenant_id, seq, hash, ${`anchors/${tenant}/${seq}.json`} from audit.log where tenant_id = ${tenant} and seq = ${seq}`;
  }

  it("editing one entry's contents breaks the chain at that entry", async () => {
    const tenant = await chainWith("tamper-edit");
    await asRogueDba(() => admin`update audit.log set after_data = jsonb_set(after_data, '{label}', '"changed"') where tenant_id = ${tenant} and seq = 5`);
    expect(await chainOf(tenant)).toMatchObject({ ok: false, badSeq: 5, reason: expect.stringContaining("altered") });
  });

  it("editing a link (prev_hash) is detected", async () => {
    const tenant = await chainWith("tamper-link");
    await asRogueDba(() => admin`update audit.log set prev_hash = repeat('a', 64) where tenant_id = ${tenant} and seq = 6`);
    expect(await chainOf(tenant)).toMatchObject({ ok: false, badSeq: 6, reason: expect.stringContaining("prev_hash") });
  });

  it("deleting a middle entry is detected at the gap", async () => {
    const tenant = await chainWith("tamper-delete");
    await asRogueDba(() => admin`delete from audit.log where tenant_id = ${tenant} and seq = 4`);
    expect(await chainOf(tenant)).toMatchObject({ ok: false, badSeq: 5, reason: expect.stringContaining("missing") });
  });

  it("editing an entry AND recomputing its own hash is still detected, at the next entry", async () => {
    const tenant = await chainWith("tamper-recompute");
    await asRogueDba(async () => {
      await admin`update audit.log set after_data = jsonb_set(after_data, '{label}', '"changed"') where tenant_id = ${tenant} and seq = 5`;
      await admin`update audit.log set hash = audit.compute_hash(prev_hash, tenant_id, seq, occurred_at, event_key, actor_kind,
                    actor_id, impersonator_id, session_id, device_id, pin_verification_id, table_name, row_id,
                    before_data, after_data, txid, device_at)
                  where tenant_id = ${tenant} and seq = 5`;
    });
    expect(await chainOf(tenant)).toMatchObject({ ok: false, badSeq: 6, reason: expect.stringContaining("prev_hash") });
  });

  it("rewriting the ENTIRE chain from the edit onward passes the chain check, but the anchor exposes it", async () => {
    const tenant = await chainWith("tamper-rewrite");
    await anchorHead(tenant, 10); // the nightly job copied the head outside the database
    expect((await anchorsOf(tenant)).map((a) => a.ok)).toEqual([true]);

    await asRogueDba(async () => {
      await admin`update audit.log set after_data = jsonb_set(after_data, '{label}', '"forged"') where tenant_id = ${tenant} and seq = 5`;
      await admin.unsafe(`
        do $$
        declare r audit.log%rowtype; v_prev text;
        begin
          select hash into v_prev from audit.log where tenant_id = '${tenant}' and seq = 4;
          for r in select * from audit.log where tenant_id = '${tenant}' and seq >= 5 order by seq loop
            update audit.log set prev_hash = v_prev,
              hash = audit.compute_hash(v_prev, r.tenant_id, r.seq, r.occurred_at, r.event_key, r.actor_kind,
                       r.actor_id, r.impersonator_id, r.session_id, r.device_id, r.pin_verification_id,
                       r.table_name, r.row_id, r.before_data,
                       case when r.seq = 5 then jsonb_set(r.after_data, '{label}', '"forged"') else r.after_data end,
                       r.txid, r.device_at)
            where tenant_id = r.tenant_id and seq = r.seq
            returning hash into v_prev;
          end loop;
        end $$`);
    });

    expect(await chainOf(tenant)).toMatchObject({ ok: true, checked: 10 }); // a perfect forgery...
    const anchors = await anchorsOf(tenant);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toMatchObject({ ok: false, reason: expect.stringContaining("rewritten") }); // ...caught
  });

  it("deleting the newest entries passes the chain check, but the anchor exposes it", async () => {
    const tenant = await chainWith("tamper-tail");
    await anchorHead(tenant, 10);
    await asRogueDba(() => admin`delete from audit.log where tenant_id = ${tenant} and seq >= 9`);
    expect(await chainOf(tenant)).toMatchObject({ ok: true, checked: 8 });
    expect((await anchorsOf(tenant))[0]).toMatchObject({ ok: false, reason: expect.stringContaining("removed") });
  });

  it("an untouched chain with anchors verifies clean", async () => {
    const tenant = await chainWith("tamper-none", 6);
    await anchorHead(tenant, 3);
    await anchorHead(tenant, 6);
    expect((await anchorsOf(tenant)).map((a) => a.ok)).toEqual([true, true]);
    expect(await chainOf(tenant)).toMatchObject({ ok: true, checked: 6 });
  });

  it("every protection was put back afterwards", async () => {
    const [row] = await admin<{ n: number }[]>`
      select count(*)::int as n from pg_trigger
      where tgrelid = 'audit.log'::regclass and tgname = 'audit_log_immutable_rows' and tgenabled = 'O'`;
    expect(row?.n).toBe(1);
  });
});

// ── volume and concurrency ───────────────────────────────────────────────────
describe("under load", () => {
  it("1,000 random writes across three shops leave three chains that verify (done-when for A5)", async () => {
    const tenants = [await newTenant("load-1"), await newTenant("load-2"), await newTenant("load-3")];
    const rows = new Map<string, string[]>(tenants.map((t) => [t, []]));
    const expected = new Map<string, number>(tenants.map((t) => [t, 0]));
    const bump = (t: string, n = 1) => expected.set(t, (expected.get(t) ?? 0) + n);

    // deterministic pseudo-random, so a failure can be reproduced
    let seed = 20261016;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const pick = <T,>(items: T[]) => items[Math.floor(rand() * items.length)] as T;

    for (let i = 0; i < 1000; i++) {
      const tenant = pick(tenants);
      const mine = rows.get(tenant) ?? [];
      const roll = rand();
      if (roll < 0.1) {
        // a batch that fails: must leave nothing behind and no gap
        await db.rls({ tenantId: tenant }, async (tx) => {
          for (let k = 0; k < 3; k++) await run(tx, sql`insert into app.audit_probe (id, tenant_id, label) values (${newId()}, ${tenant}, 'doomed')`);
          throw new Error("fail");
        }, { write: true }).catch(() => undefined);
      } else if (roll < 0.45 || mine.length === 0) {
        mine.push(await insertRow(tenant, { label: `n${i}` }));
        bump(tenant);
      } else if (roll < 0.75) {
        const id = pick(mine);
        await db.rls({ tenantId: tenant }, (tx) => run(tx, sql`update app.audit_probe set label = ${`u${i}`} where id = ${id}`), { write: true });
        bump(tenant);
      } else if (roll < 0.85) {
        const id = pick(mine);
        await db.rls({ tenantId: tenant }, (tx) => run(tx, sql`update app.audit_probe set noise = ${i + 1} where id = ${id}`), { write: true });
      } else if (roll < 0.95) {
        const id = mine.splice(Math.floor(rand() * mine.length), 1)[0];
        await db.rls({ tenantId: tenant }, (tx) => run(tx, sql`delete from app.audit_probe where id = ${id ?? ""}::uuid`), { write: true });
        bump(tenant);
      } else {
        // two changes in one transaction
        const id = await newId();
        await db.rls({ tenantId: tenant }, async (tx) => {
          await run(tx, sql`insert into app.audit_probe (id, tenant_id, label) values (${id}, ${tenant}, 'pair')`);
          await run(tx, sql`update app.audit_probe set price = ${i} where id = ${id}`);
        }, { write: true });
        mine.push(id);
        bump(tenant, 2);
      }
    }

    for (const tenant of tenants) {
      const entries = await entriesOf(tenant);
      expect(entries.length).toBe(expected.get(tenant));
      expect(entries.map((e) => e.seq)).toEqual(entries.map((_, i) => i + 1));
      for (let i = 1; i < entries.length; i++) {
        expect((entries[i]?.occurred_at.getTime() ?? 0) >= (entries[i - 1]?.occurred_at.getTime() ?? 0)).toBe(true);
      }
      expect(await chainOf(tenant)).toMatchObject({ ok: true, checked: entries.length });
    }
  }, 120_000);

  it.each([
    ["with the lock taken first (write: true)", true],
    ["with the lock taken at the first audited write", false],
  ])("eight writers on one shop at once keep one gapless chain %s", async (_label, write) => {
    const tenant = await newTenant(write ? "conc-w" : "conc-l");
    const staff = await staffCtx(tenant);
    const baseline = (await entriesOf(tenant)).length;
    const workers = Array.from({ length: 8 }, async (_, w) => {
      for (let i = 0; i < 30; i++) {
        await db.rls(staff, (tx) =>
          run(tx, sql`insert into app.audit_probe (id, tenant_id, label) values (${newId()}, ${tenant}, ${`w${w}-${i}`})`), { write });
      }
    });
    await Promise.all(workers);
    expect(await chainOf(tenant)).toMatchObject({ ok: true, checked: baseline + 240 });
    expect(Number((await entriesOf(tenant)).at(-1)?.seq)).toBe(baseline + 240);
  }, 60_000);
});

describe("deadlock hazard (why rls() has a write mode)", () => {
  async function opposingWriters(write: boolean) {
    const tenant = await newTenant(write ? "dead-fix" : "dead-bug");
    const r1 = await insertRow(tenant);
    const r2 = await insertRow(tenant);
    const touch = (tx: RlsTransaction, id: string) => run(tx, sql`update app.audit_probe set label = ${newId()} where id = ${id}`);

    const first = db.rls({ tenantId: tenant }, async (tx) => { await touch(tx, r1); await sleep(400); await touch(tx, r2); }, { write });
    await sleep(150);
    const second = db.rls({ tenantId: tenant }, async (tx) => { await touch(tx, r2); await sleep(400); await touch(tx, r1); }, { write });
    const results = await Promise.allSettled([first, second]);
    return { tenant, results };
  }

  it("without write mode, two writers touching rows in opposite orders can deadlock (Postgres aborts one)", async () => {
    const { results } = await opposingWriters(false);
    const failures = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(failures.length).toBeGreaterThanOrEqual(1);
    expect(failures.every((f) => pgCode(f.reason) === "40P01")).toBe(true);
  }, 30_000);

  it("with write mode, the same two writers simply take turns and both succeed", async () => {
    const { tenant, results } = await opposingWriters(true);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await chainOf(tenant)).toMatchObject({ ok: true });
  }, 30_000);
});
