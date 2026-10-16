import { sql } from "drizzle-orm";
import { char, check, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { RESERVED_TENANT_SLUGS, type LocalizedText } from "@retail/core";

/**
 * `platform` holds data about the shops themselves (DATA_MODEL §3.1). Only `db.admin`
 * (console, jobs, scripts) can touch it: no tenant-facing role has any privilege on this
 * schema (migration 0001), so a tenant request cannot even see it.
 */
export const platformSchema = pgSchema("platform");

export const industry = platformSchema.enum("industry", ["electronics", "minimarket", "cosmetics", "food", "other"]);

export const tenantStatus = platformSchema.enum("tenant_status", [
  "pilot",
  "trial",
  "active",
  "past_due",
  "paused", // read-only access plus export, never deleted (PLAN.md §7.16)
  "closed",
]);

const reservedList = RESERVED_TENANT_SLUGS.map((slug) => `'${slug}'`).join(", ");

export const tenants = platformSchema.table(
  "tenants",
  {
    id: uuid("id").primaryKey(),
    /** The shop's subdomain (PLAN.md D2). */
    slug: text("slug").notNull().unique("tenants_slug_unique"),
    displayName: jsonb("display_name").$type<LocalizedText>().notNull(),
    legalName: text("legal_name"),
    tin: text("tin"),
    industry: industry("industry").notNull(),
    planKey: text("plan_key").notNull(),
    status: tenantStatus("status").notNull().default("pilot"),
    timezone: text("timezone").notNull().default("Africa/Addis_Ababa"),
    currency: char("currency", { length: 3 }).notNull().default("ETB"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    check("tenants_slug_format", sql`${t.slug} ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'`),
    check("tenants_slug_not_reserved", sql.raw(`slug NOT IN (${reservedList})`)),
    check(
      "tenants_display_name_not_empty",
      sql`jsonb_typeof(${t.displayName}) = 'object' AND ${t.displayName} <> '{}'::jsonb`,
    ),
  ],
);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
