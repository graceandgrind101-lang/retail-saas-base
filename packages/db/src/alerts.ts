import { sql } from "drizzle-orm";
import { ALERT_CATEGORIES, ALERT_RULES, uuidv7, type AlertCategory, type AlertRuleKey, type AlertSeverity, type AlertStatus } from "@retail/core";
import { requirePermission } from "./permissions";
import type { RlsTransaction } from "./rls";

/**
 * Alerts (Phase A task A10). PIN lockouts raise theirs inside the database. Other code raises
 * one with `raiseAlert`, naming a RULE from core's registry: the rule fixes the category and
 * severity, so the caller cannot downgrade a fraud signal. The payload must hold no secrets and
 * no personal contact details. Reading needs `alert:view`, closing needs `alert:resolve`.
 */

export interface RaiseAlertInput {
  ruleKey: AlertRuleKey;
  /** Made by the caller so that replaying the same request raises the alert once. */
  id?: string;
  branchId?: string;
  entityType?: string;
  entityId?: string;
  payload?: Record<string, unknown>;
}

/** Raise an alert in the signed-in person's shop. Run with `write: true`. Returns the alert's id. */
export async function raiseAlert(tx: RlsTransaction, input: RaiseAlertInput): Promise<string> {
  const rule = ALERT_RULES[input.ruleKey];
  const id = input.id ?? uuidv7();
  const payload = JSON.stringify(input.payload ?? {});
  await tx.execute(sql`
    select app.raise_alert(
      ${id}::uuid, ${input.ruleKey}, ${rule.category}, ${rule.severity}::int, ${input.branchId ?? null}::uuid,
      ${input.entityType ?? null}, ${input.entityId ?? null}::uuid, ${payload}::text::jsonb)`);
  return id;
}

export interface AlertRow {
  id: string;
  category: AlertCategory;
  ruleKey: string;
  severity: AlertSeverity;
  branchId: string | null;
  entityType: string | null;
  entityId: string | null;
  payload: Record<string, unknown>;
  status: AlertStatus;
  assigneeStaffId: string | null;
  resolutionNote: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

export interface ListAlertsInput {
  /** Default: the open ones (new and ack). */
  statuses?: readonly AlertStatus[];
  categories?: readonly AlertCategory[];
  /** 1 to 200, default 50. */
  limit?: number;
  offset?: number;
}

/** Newest first, most severe first within the same moment's batch. Needs `alert:view`. */
export async function listAlerts(tx: RlsTransaction, input: ListAlertsInput = {}): Promise<AlertRow[]> {
  await requirePermission(tx, "alert:view");
  const statuses = JSON.stringify(input.statuses ?? ["new", "ack"]);
  const categories = JSON.stringify(input.categories ?? ALERT_CATEGORIES);
  const limit = Math.min(200, Math.max(1, Math.floor(input.limit ?? 50)));
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const rows = await tx.execute<{
    id: string;
    category: AlertCategory;
    rule_key: string;
    severity: number;
    branch_id: string | null;
    entity_type: string | null;
    entity_id: string | null;
    payload: Record<string, unknown>;
    status: AlertStatus;
    assignee_staff_id: string | null;
    resolution_note: string | null;
    resolved_by: string | null;
    resolved_at: string | Date | null;
    created_at: string | Date;
  }>(sql`
    select id, category, rule_key, severity, branch_id, entity_type, entity_id, payload, status,
           assignee_staff_id, resolution_note, resolved_by, resolved_at, created_at
    from app.alerts
    where status in (select jsonb_array_elements_text(${statuses}::text::jsonb))
      and category in (select jsonb_array_elements_text(${categories}::text::jsonb))
    order by created_at desc, severity desc, id desc
    limit ${limit} offset ${offset}`);
  return rows.map((r) => ({
    id: r.id,
    category: r.category,
    ruleKey: r.rule_key,
    severity: r.severity as AlertSeverity,
    branchId: r.branch_id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    payload: r.payload,
    status: r.status,
    assigneeStaffId: r.assignee_staff_id,
    resolutionNote: r.resolution_note,
    resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at ? new Date(r.resolved_at) : null,
    createdAt: new Date(r.created_at),
  }));
}

/** How many open alerts there are per category (the tiles on the alerts screen). Needs `alert:view`. */
export async function countOpenAlerts(tx: RlsTransaction): Promise<Record<AlertCategory, number>> {
  await requirePermission(tx, "alert:view");
  const rows = await tx.execute<{ category: AlertCategory; n: number }>(
    sql`select category, count(*)::int as n from app.alerts where status in ('new', 'ack') group by category`,
  );
  const counts = Object.fromEntries(ALERT_CATEGORIES.map((c) => [c, 0])) as Record<AlertCategory, number>;
  for (const r of rows) counts[r.category] = r.n;
  return counts;
}

/**
 * Acknowledge, resolve or dismiss. Needs `alert:resolve`; the life cycle is enforced (closed is
 * final). A note is kept when closing. Run with `write: true`.
 */
export async function setAlertStatus(tx: RlsTransaction, input: { alertId: string; status: Exclude<AlertStatus, "new">; note?: string }): Promise<void> {
  await tx.execute(sql`select app.set_alert_status(${input.alertId}::uuid, ${input.status}, ${input.note ?? null})`);
}
