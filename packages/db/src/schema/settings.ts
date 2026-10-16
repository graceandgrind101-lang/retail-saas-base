import { sql } from "drizzle-orm";
import { check, foreignKey, jsonb, text, unique, uuid } from "drizzle-orm/pg-core";
import { staff } from "./staff";
import { tenantTable } from "./tenant-table";

/**
 * What a shop has chosen for each setting (PLAN.md §4). Only the choices that differ from the
 * default are stored; the registry in core (`SETTINGS`) says which keys exist and what each may hold.
 * Written only through `app.set_setting` (migration 0014), which refuses a locked setting and asks
 * for a PIN approval on a sensitive one; a direct write from the shop's own login is refused.
 * Every change is in the audit log with who made it.
 */
export const tenantSettings = tenantTable(
  "tenant_settings",
  {
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    updatedBy: uuid("updated_by"),
  },
  (t) => [
    foreignKey({ name: "tenant_settings_updated_by_fk", columns: [t.tenantId, t.updatedBy], foreignColumns: [staff.tenantId, staff.id] }),
    unique("tenant_settings_tenant_key_unique").on(t.tenantId, t.key),
    check("tenant_settings_key_format", sql`${t.key} ~ '^[a-z][a-z_]*\\.[a-z][a-z_]*$'`),
    // a JSON null is "no value": removing a choice is not done by storing null
    check("tenant_settings_value_not_null", sql`${t.value} <> 'null'::jsonb`),
  ],
);

export type TenantSetting = typeof tenantSettings.$inferSelect;
