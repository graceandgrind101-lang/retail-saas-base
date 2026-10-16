import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { roles } from "./roles";
import { appSchema, tenantTable } from "./tenant-table";

export const staffStatus = appSchema.enum("staff_status", ["invited", "active", "suspended", "archived"]);

/**
 * One person in one shop (DATA_MODEL M1). A staff row may link to a login account
 * (`auth_user_id`, for owners and managers) or be PIN-only (cashiers, no account at all).
 * The same account can be staff in several shops: one row per shop.
 *
 * Secrets in this table (`pin_hash`, `invite_token_hash`) are recorded in the audit log as
 * "[redacted]" (migration 0006), and the security check fails if any secret-looking column is not.
 */
export const staff = tenantTable(
  "staff",
  {
    authUserId: uuid("auth_user_id"),
    displayName: text("display_name").notNull(),
    phone: text("phone"),
    roleId: uuid("role_id").notNull(),
    /** Branches this person may work in; null means all of them. Checked by the app, not a foreign key. */
    branchIds: uuid("branch_ids").array(),
    pinHash: text("pin_hash"),
    pinSetAt: timestamp("pin_set_at", { withTimezone: true }),
    pinFailedCount: integer("pin_failed_count").notNull().default(0),
    pinLockedUntil: timestamp("pin_locked_until", { withTimezone: true }),
    status: staffStatus("status").notNull().default("invited"),
    /** A locale that has a message file; null follows the shop's default. */
    preferredLanguage: text("preferred_language"),
    preferredCalendar: text("preferred_calendar"),
    theme: text("theme"),
    // An invitation to sign in with an account. Only the token's hash is stored (core: hashInviteToken).
    inviteEmail: text("invite_email"),
    inviteTokenHash: text("invite_token_hash"),
    inviteExpiresAt: timestamp("invite_expires_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: "staff_role_fk",
      columns: [t.tenantId, t.roleId],
      foreignColumns: [roles.tenantId, roles.id],
    }),
    // One staff row per account per shop (an account may be staff in many shops).
    uniqueIndex("staff_tenant_auth_user_unique").on(t.tenantId, t.authUserId).where(sql`${t.authUserId} IS NOT NULL`),
    // Looked up across ALL shops by whoever follows an invitation link, so unique globally.
    uniqueIndex("staff_invite_token_unique").on(t.inviteTokenHash).where(sql`${t.inviteTokenHash} IS NOT NULL`),
    check("staff_display_name_not_empty", sql`btrim(${t.displayName}) <> ''`),
    // An invited person has a complete, unexpired-able invitation and no account yet...
    check(
      "staff_invite_complete",
      sql`${t.status} <> 'invited' OR (${t.inviteTokenHash} IS NOT NULL AND ${t.inviteEmail} IS NOT NULL AND ${t.inviteExpiresAt} IS NOT NULL AND ${t.authUserId} IS NULL)`,
    ),
    // ...and anyone else holds no leftover invitation token.
    check("staff_no_stale_invite", sql`${t.status} = 'invited' OR ${t.inviteTokenHash} IS NULL`),
    check("staff_invite_email_lowercase", sql`${t.inviteEmail} IS NULL OR ${t.inviteEmail} = lower(${t.inviteEmail})`),
    check("staff_pin_failed_count", sql`${t.pinFailedCount} >= 0`),
    check("staff_calendar", sql`${t.preferredCalendar} IS NULL OR ${t.preferredCalendar} IN ('gregorian', 'ethiopian')`),
    check("staff_theme", sql`${t.theme} IS NULL OR ${t.theme} IN ('system', 'light', 'dark')`),
  ],
);

/**
 * A sign-in. Kept in the database (not only in a cookie) so ending it takes effect on the very
 * next request, from any device: suspend the person, or end the session, and the check at the
 * start of every request (`private.assert_session_active`) refuses it.
 */
export const staffSessions = tenantTable(
  "staff_sessions",
  {
    staffId: uuid("staff_id").notNull(),
    /** The paired till this sign-in happened on (task A8 adds the foreign key); null for the admin app. */
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
    check("staff_sessions_method", sql`${t.method} IN ('pin', 'password', 'google', 'telegram')`),
    check(
      "staff_sessions_ended_reason",
      sql`${t.endedReason} IS NULL OR ${t.endedReason} IN ('logout', 'expired', 'revoked', 'staff_suspended', 'device_revoked')`,
    ),
    // A session is either still open (no end, no reason) or closed with a reason, never half of each.
    check("staff_sessions_ended_consistent", sql`(${t.endedAt} IS NULL) = (${t.endedReason} IS NULL)`),
    check("staff_sessions_expiry_after_start", sql`${t.expiresAt} > ${t.startedAt}`),
    index("staff_sessions_open_idx").on(t.tenantId, t.staffId).where(sql`${t.endedAt} IS NULL`),
  ],
);

export type Staff = typeof staff.$inferSelect;
export type StaffSession = typeof staffSessions.$inferSelect;
