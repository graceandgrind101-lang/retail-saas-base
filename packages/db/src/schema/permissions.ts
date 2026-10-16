import { sql } from "drizzle-orm";
import { check, foreignKey, text, uuid, unique } from "drizzle-orm/pg-core";
import { staff } from "./staff";
import { tenantTable } from "./tenant-table";

/**
 * A personal exception to a person's role (PLAN.md §5): `allow` adds a key the role lacks,
 * `deny` removes one it has. A deny always wins (core: resolvePermissions). Written only through
 * the functions in migration 0010, which enforce who may grant what; a direct write from the
 * shop's own login is refused. A reason is required and the change is audited.
 */
export const staffPermissionOverrides = tenantTable(
  "staff_permission_overrides",
  {
    staffId: uuid("staff_id").notNull(),
    permissionKey: text("permission_key").notNull(),
    effect: text("effect").notNull(),
    reason: text("reason").notNull(),
    grantedBy: uuid("granted_by").notNull(),
  },
  (t) => [
    foreignKey({ name: "staff_permission_overrides_staff_fk", columns: [t.tenantId, t.staffId], foreignColumns: [staff.tenantId, staff.id] }),
    foreignKey({ name: "staff_permission_overrides_granted_by_fk", columns: [t.tenantId, t.grantedBy], foreignColumns: [staff.tenantId, staff.id] }),
    unique("staff_permission_overrides_unique").on(t.tenantId, t.staffId, t.permissionKey),
    check("staff_permission_overrides_key_format", sql`${t.permissionKey} ~ '^[a-z][a-z_]*:[a-z][a-z_]*$'`),
    check("staff_permission_overrides_effect", sql`${t.effect} IN ('allow', 'deny')`),
    check("staff_permission_overrides_reason", sql`btrim(${t.reason}) <> ''`),
  ],
);

export type StaffPermissionOverride = typeof staffPermissionOverrides.$inferSelect;
