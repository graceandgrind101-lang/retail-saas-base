import { sql } from "drizzle-orm";
import { check, foreignKey, integer, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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

export type Staff = typeof staff.$inferSelect;
