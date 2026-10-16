import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, jsonb, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import type { LocalizedText } from "@retail/core";
import { tenantTable } from "./tenant-table";

/**
 * Roles a shop's staff can hold (PLAN.md §5). Every shop starts with the five system roles
 * (core: SYSTEM_ROLES), created by provisionTenant. What a role may DO is `role_permissions`,
 * which is filled and enforced by the permission resolver in task A9.
 */
export const roles = tenantTable(
  "roles",
  {
    key: text("key").notNull(),
    name: jsonb("name").$type<LocalizedText>().notNull(),
    isSystem: boolean("is_system").notNull().default(false),
    /** Which system template a custom role was copied from, if any. */
    templateKey: text("template_key"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    unique("roles_tenant_key_unique").on(t.tenantId, t.key),
    check("roles_key_format", sql`${t.key} ~ '^[a-z][a-z_]*$'`),
    check("roles_name_not_empty", sql`jsonb_typeof(${t.name}) = 'object' AND ${t.name} <> '{}'::jsonb`),
  ],
);

/** Which permission keys a role holds. Keys look like `product:edit_price` (resource:action). */
export const rolePermissions = tenantTable(
  "role_permissions",
  {
    roleId: uuid("role_id").notNull(),
    permissionKey: text("permission_key").notNull(),
  },
  (t) => [
    // Composite key: a role's permissions can only point at a role of the SAME shop (DATA_MODEL M4).
    foreignKey({
      name: "role_permissions_role_fk",
      columns: [t.tenantId, t.roleId],
      foreignColumns: [roles.tenantId, roles.id],
    }),
    unique("role_permissions_unique").on(t.tenantId, t.roleId, t.permissionKey),
    check("role_permissions_key_format", sql`${t.permissionKey} ~ '^[a-z][a-z_]*:[a-z][a-z_]*$'`),
  ],
);

export type Role = typeof roles.$inferSelect;
