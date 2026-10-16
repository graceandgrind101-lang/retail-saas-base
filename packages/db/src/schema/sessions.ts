import { sql } from "drizzle-orm";
import { check, foreignKey, index, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { devices } from "./devices";
import { staff } from "./staff";
import { tenantTable } from "./tenant-table";

/**
 * A sign-in. Kept in the database (not only in a cookie) so ending it takes effect on the very
 * next request, from any device: suspend the person, or end the session, and the check at the
 * start of every request (`private.assert_session_active`) refuses it.
 */
export const staffSessions = tenantTable(
  "staff_sessions",
  {
    staffId: uuid("staff_id").notNull(),
    /** The paired till this sign-in happened on; null for the admin app. */
    deviceId: uuid("device_id"),
    method: text("method").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedReason: text("ended_reason"),
  },
  (t) => [
    foreignKey({
      name: "staff_sessions_staff_fk",
      columns: [t.tenantId, t.staffId],
      foreignColumns: [staff.tenantId, staff.id],
    }),
    foreignKey({
      name: "staff_sessions_device_fk",
      columns: [t.tenantId, t.deviceId],
      foreignColumns: [devices.tenantId, devices.id],
    }),
    check("staff_sessions_method", sql`${t.method} IN ('pin', 'password', 'google', 'telegram')`),
    // A PIN sign-in only ever happens on a paired device.
    check("staff_sessions_pin_needs_device", sql`${t.method} <> 'pin' OR ${t.deviceId} IS NOT NULL`),
    check(
      "staff_sessions_ended_reason",
      sql`${t.endedReason} IS NULL OR ${t.endedReason} IN ('logout', 'expired', 'revoked', 'staff_suspended', 'device_revoked')`,
    ),
    // A session is either still open (no end, no reason) or closed with a reason, never half of each.
    check("staff_sessions_ended_consistent", sql`(${t.endedAt} IS NULL) = (${t.endedReason} IS NULL)`),
    check("staff_sessions_expiry_after_start", sql`${t.expiresAt} > ${t.startedAt}`),
    index("staff_sessions_open_idx").on(t.tenantId, t.staffId).where(sql`${t.endedAt} IS NULL`),
    index("staff_sessions_device_open_idx").on(t.tenantId, t.deviceId).where(sql`${t.endedAt} IS NULL`),
  ],
);

export type StaffSession = typeof staffSessions.$inferSelect;
