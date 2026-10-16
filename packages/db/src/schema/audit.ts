import { bigint, jsonb, pgSchema, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Read-only description of the audit log, for typed queries (record timelines, the owner's
 * activity screen). The table itself is created and protected by migration 0002, NOT by
 * Drizzle: drizzle.config.ts only generates for `platform` and `app`. Tenant sessions can
 * only SELECT from it; nothing can change it.
 */
export const auditSchema = pgSchema("audit");

export const auditLog = auditSchema.table(
  "log",
  {
    tenantId: uuid("tenant_id").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    deviceAt: timestamp("device_at", { withTimezone: true }),
    eventKey: text("event_key").notNull(),
    actorKind: text("actor_kind").notNull(),
    actorId: uuid("actor_id"),
    impersonatorId: uuid("impersonator_id"),
    sessionId: uuid("session_id"),
    deviceId: uuid("device_id"),
    pinVerificationId: uuid("pin_verification_id"),
    tableName: text("table_name"),
    rowId: uuid("row_id"),
    beforeData: jsonb("before_data").$type<Record<string, unknown> | null>(),
    afterData: jsonb("after_data").$type<Record<string, unknown> | null>(),
    txid: bigint("txid", { mode: "number" }).notNull(),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.seq] })],
);

export type AuditEntry = typeof auditLog.$inferSelect;
