import { sql } from "drizzle-orm";
import { boolean, char, check, jsonb, pgSchema, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
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

/**
 * Which modules a shop has switched on. Whether a key MEANS something is decided by the
 * registry in @retail/core; the database only checks the key is well formed, so adding a
 * module needs no migration. Shop sessions read their own row set through `app.my_modules()`.
 */
export const tenantModules = platformSchema.table(
  "tenant_modules",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    moduleKey: text("module_key").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.moduleKey] }),
    check("tenant_modules_key_format", sql`${t.moduleKey} ~ '^[a-z][a-z_]*$'`),
  ],
);

export const settingState = platformSchema.enum("setting_state", ["editable", "locked", "hidden"]);

/**
 * Who may change which setting (PLAN.md D7, §4). A row with a null tenant is the platform
 * default; a row for one shop overrides it. Lookup order: the shop's row, then the default,
 * then the default written in the settings registry in code.
 */
export const settingPolicies = platformSchema.table(
  "setting_policies",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").references(() => tenants.id),
    key: text("key").notNull(),
    state: settingState("state").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // NULLS NOT DISTINCT: there can be only one platform-default row per key, not one per NULL.
    unique("setting_policies_tenant_key_unique").on(t.tenantId, t.key).nullsNotDistinct(),
    check("setting_policies_key_format", sql`${t.key} ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$'`),
  ],
);
