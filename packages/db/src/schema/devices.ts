import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches";
import { staff } from "./staff";
import { tenantTable } from "./tenant-table";

/**
 * A paired till: a phone, tablet or computer that a shop's owner or manager has connected to a
 * branch (DATA_MODEL §3.2). The device keeps a secret token; only its HMAC is stored here
 * (`token_hash`), so reading the database never gives anyone a working device.
 * PIN sign-in only works on a device that is paired and not revoked.
 */
export const devices = tenantTable(
  "devices",
  {
    branchId: uuid("branch_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    tokenHash: text("token_hash").notNull(),
    pairedBy: uuid("paired_by").notNull(),
    pairedAt: timestamp("paired_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    userAgent: text("user_agent"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by"),
    /** Wrong PINs in a row on this device (any staff); five lock it for 15 minutes. */
    pinFailedCount: integer("pin_failed_count").notNull().default(0),
    pinLockedUntil: timestamp("pin_locked_until", { withTimezone: true }),
  },
  (t) => [
    foreignKey({ name: "devices_branch_fk", columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ name: "devices_paired_by_fk", columns: [t.tenantId, t.pairedBy], foreignColumns: [staff.tenantId, staff.id] }),
    foreignKey({ name: "devices_revoked_by_fk", columns: [t.tenantId, t.revokedBy], foreignColumns: [staff.tenantId, staff.id] }),
    // Looked up by token WITHOUT knowing the shop, so unique across all shops.
    uniqueIndex("devices_token_hash_unique").on(t.tokenHash),
    check("devices_name_not_empty", sql`btrim(${t.name}) <> ''`),
    check("devices_kind", sql`${t.kind} IN ('pos', 'phone', 'tablet', 'desktop')`),
    check("devices_revoked_consistent", sql`(${t.revokedAt} IS NULL) = (${t.revokedBy} IS NULL)`),
    check("devices_pin_failed_count", sql`${t.pinFailedCount} >= 0`),
    index("devices_branch_idx").on(t.tenantId, t.branchId),
  ],
);

/** A one-time code (shown as a QR or XXXX-XXXX) that turns a new device into a paired one. Valid 10 minutes. */
export const devicePairingCodes = tenantTable(
  "device_pairing_codes",
  {
    branchId: uuid("branch_id").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    usedByDeviceId: uuid("used_by_device_id"),
  },
  (t) => [
    foreignKey({ name: "device_pairing_codes_branch_fk", columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ name: "device_pairing_codes_device_fk", columns: [t.tenantId, t.usedByDeviceId], foreignColumns: [devices.tenantId, devices.id] }),
    // Looked up by code WITHOUT knowing the shop, so unique across all shops.
    uniqueIndex("device_pairing_codes_hash_unique").on(t.codeHash),
    check("device_pairing_codes_expiry_after_creation", sql`${t.expiresAt} > ${t.createdAt}`),
    check("device_pairing_codes_used_consistent", sql`(${t.usedAt} IS NULL) = (${t.usedByDeviceId} IS NULL)`),
  ],
);

/**
 * Proof that a person typed their PIN to approve ONE action (a manager approving a below-floor
 * sale on a cashier's till). Single use, 2 minutes, bound to the action and, where it applies,
 * to the one record. The audit log stores the id, so a dispute can ask "whose PIN approved this?".
 */
export const pinVerifications = tenantTable(
  "pin_verifications",
  {
    /** Whose PIN was entered. */
    staffId: uuid("staff_id").notNull(),
    /** The staff member whose session asked for the approval (the cashier). */
    requestedBy: uuid("requested_by").notNull(),
    deviceId: uuid("device_id"),
    actionKey: text("action_key").notNull(),
    entityId: uuid("entity_id"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({ name: "pin_verifications_staff_fk", columns: [t.tenantId, t.staffId], foreignColumns: [staff.tenantId, staff.id] }),
    foreignKey({ name: "pin_verifications_requested_by_fk", columns: [t.tenantId, t.requestedBy], foreignColumns: [staff.tenantId, staff.id] }),
    foreignKey({ name: "pin_verifications_device_fk", columns: [t.tenantId, t.deviceId], foreignColumns: [devices.tenantId, devices.id] }),
    check("pin_verifications_action_key", sql`${t.actionKey} ~ '^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$'`),
    check("pin_verifications_expiry", sql`${t.expiresAt} > ${t.verifiedAt}`),
  ],
);

export type Device = typeof devices.$inferSelect;
export type DevicePairingCode = typeof devicePairingCodes.$inferSelect;
export type PinVerification = typeof pinVerifications.$inferSelect;
