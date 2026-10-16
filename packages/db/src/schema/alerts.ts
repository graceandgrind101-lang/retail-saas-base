import { sql } from "drizzle-orm";
import { check, foreignKey, index, jsonb, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { branches } from "./branches";
import { staff } from "./staff";
import { tenantTable } from "./tenant-table";

/**
 * Things the owner should look at (PLAN.md §6.3). Raised by the system (a PIN lockout) or by the
 * signed-in person's request (a below-floor sale, later), and closed by someone holding
 * `alert:resolve`. Written only through the functions in migration 0012; a direct write from the
 * shop's own login is refused. Closed alerts are final and never deleted.
 *
 * The payload must hold no secrets and no personal contact details.
 */
export const alerts = tenantTable(
  "alerts",
  {
    branchId: uuid("branch_id"),
    category: text("category").notNull(),
    ruleKey: text("rule_key").notNull(),
    severity: smallint("severity").notNull(),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    payload: jsonb("payload").notNull().default({}),
    status: text("status").notNull().default("new"),
    assigneeStaffId: uuid("assignee_staff_id"),
    resolutionNote: text("resolution_note"),
    resolvedBy: uuid("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    foreignKey({ name: "alerts_branch_fk", columns: [t.tenantId, t.branchId], foreignColumns: [branches.tenantId, branches.id] }),
    foreignKey({ name: "alerts_assignee_fk", columns: [t.tenantId, t.assigneeStaffId], foreignColumns: [staff.tenantId, staff.id] }),
    foreignKey({ name: "alerts_resolved_by_fk", columns: [t.tenantId, t.resolvedBy], foreignColumns: [staff.tenantId, staff.id] }),
    check("alerts_category", sql`${t.category} IN ('fraud', 'suspicion', 'error', 'alert', 'message', 'info')`),
    check("alerts_status", sql`${t.status} IN ('new', 'ack', 'resolved', 'dismissed')`),
    check("alerts_severity", sql`${t.severity} BETWEEN 1 AND 5`),
    check("alerts_rule_key_format", sql`${t.ruleKey} ~ '^[a-z0-9_]+(\\.[a-z0-9_]+)+$'`),
    check("alerts_payload_is_object", sql`jsonb_typeof(${t.payload}) = 'object'`),
    check("alerts_entity_pair", sql`(${t.entityType} IS NULL) = (${t.entityId} IS NULL)`),
    // Closed means closed by someone, at a time; open means neither.
    check(
      "alerts_closed_consistent",
      sql`(${t.status} IN ('resolved', 'dismissed')) = (${t.resolvedAt} IS NOT NULL AND ${t.resolvedBy} IS NOT NULL)`,
    ),
    index("alerts_list_idx").on(t.tenantId, t.status, t.category, t.createdAt.desc()),
  ],
);

export type Alert = typeof alerts.$inferSelect;
