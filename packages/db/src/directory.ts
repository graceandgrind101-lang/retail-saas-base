import { sql } from "drizzle-orm";
import type { LocalizedText } from "@retail/core";
import { requirePermission } from "./permissions";
import type { RlsTransaction } from "./rls";

/**
 * Who works in the shop, what they hold, which devices are connected and what has happened
 * (Phase A task A15). Reading is checked against the person's permissions here; changing things
 * goes through the functions in migrations 0008, 0010 and 0015, which enforce the rules.
 * PIN hashes are never selected: a person only "has a PIN" or not.
 */

export type StaffStatus = "invited" | "active" | "suspended" | "archived";

export interface StaffRow {
  id: string;
  name: string;
  phone: string | null;
  status: StaffStatus;
  roleId: string;
  roleKey: string;
  hasPin: boolean;
  /** Set while the person is locked out after wrong PINs. */
  pinLockedUntil: Date | null;
  hasAccount: boolean;
  branchIds: string[] | null;
  createdAt: Date;
}

type RawStaff = {
  id: string;
  display_name: string;
  phone: string | null;
  status: StaffStatus;
  role_id: string;
  role_key: string;
  has_pin: boolean;
  pin_locked_until: string | Date | null;
  has_account: boolean;
  branch_ids: string[] | null;
  created_at: string | Date;
};

const toStaff = (r: RawStaff): StaffRow => ({
  id: r.id,
  name: r.display_name,
  phone: r.phone,
  status: r.status,
  roleId: r.role_id,
  roleKey: r.role_key,
  hasPin: r.has_pin,
  pinLockedUntil: r.pin_locked_until ? new Date(r.pin_locked_until) : null,
  hasAccount: r.has_account,
  branchIds: r.branch_ids,
  createdAt: new Date(r.created_at),
});

const STAFF_COLUMNS = sql`s.id, s.display_name, s.phone, s.status::text as status, s.role_id, r.key as role_key,
  (s.pin_hash is not null) as has_pin, s.pin_locked_until, (s.auth_user_id is not null) as has_account, s.branch_ids, s.created_at`;

/** Everyone who works here, active people first. Needs `staff:view`. */
export async function listStaff(tx: RlsTransaction): Promise<StaffRow[]> {
  await requirePermission(tx, "staff:view");
  const rows = await tx.execute<RawStaff>(sql`
    select ${STAFF_COLUMNS}
    from app.staff s join app.roles r on r.tenant_id = s.tenant_id and r.id = s.role_id
    order by case s.status when 'active' then 0 when 'invited' then 1 when 'suspended' then 2 else 3 end, lower(s.display_name), s.id`);
  return rows.map(toStaff);
}

/** One person, or null. Needs `staff:view`. */
export async function getStaffMember(tx: RlsTransaction, id: string): Promise<StaffRow | null> {
  await requirePermission(tx, "staff:view");
  const rows = await tx.execute<RawStaff>(sql`
    select ${STAFF_COLUMNS}
    from app.staff s join app.roles r on r.tenant_id = s.tenant_id and r.id = s.role_id
    where s.id = ${id}::uuid`);
  return rows[0] ? toStaff(rows[0]) : null;
}

export interface OverrideRow {
  key: string;
  effect: "allow" | "deny";
  reason: string;
  grantedBy: string | null;
}

/** A person's personal exceptions. Needs `staff:view`. */
export async function listOverrides(tx: RlsTransaction, staffId: string): Promise<OverrideRow[]> {
  await requirePermission(tx, "staff:view");
  const rows = await tx.execute<{ permission_key: string; effect: "allow" | "deny"; reason: string; granted_by_name: string | null }>(sql`
    select o.permission_key, o.effect, o.reason, g.display_name as granted_by_name
    from app.staff_permission_overrides o left join app.staff g on g.tenant_id = o.tenant_id and g.id = o.granted_by
    where o.staff_id = ${staffId}::uuid order by o.permission_key`);
  return rows.map((r) => ({ key: r.permission_key, effect: r.effect, reason: r.reason, grantedBy: r.granted_by_name }));
}

export interface RoleRow {
  id: string;
  key: string;
  name: LocalizedText;
  isSystem: boolean;
}

/** The roles a person can be given (not archived). Anyone signed in may read them. */
export async function listRoles(tx: RlsTransaction): Promise<RoleRow[]> {
  const rows = await tx.execute<{ id: string; key: string; name: LocalizedText; is_system: boolean }>(
    sql`select id, key, name, is_system from app.roles where archived_at is null order by is_system desc, key`,
  );
  return rows.map((r) => ({ id: r.id, key: r.key, name: r.name, isSystem: r.is_system }));
}

/**
 * Suspend, reinstate (suspended to active) or archive a person. Needs `staff:manage`; not yourself,
 * not someone above you, never the last owner; archived is final. Run with `write: true`.
 */
export async function setStaffStatus(tx: RlsTransaction, staffId: string, status: "active" | "suspended" | "archived"): Promise<void> {
  await tx.execute(sql`select app.set_staff_status(${staffId}::uuid, ${status})`);
}

export interface DeviceRow {
  id: string;
  name: string;
  kind: "pos" | "phone" | "tablet" | "desktop";
  branchName: LocalizedText;
  pairedAt: Date;
  pairedBy: string | null;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  lockedUntil: Date | null;
}

/** The connected devices, active ones first. Needs `device:manage`. */
export async function listDevices(tx: RlsTransaction): Promise<DeviceRow[]> {
  await requirePermission(tx, "device:manage");
  const rows = await tx.execute<{
    id: string;
    name: string;
    kind: DeviceRow["kind"];
    branch_name: LocalizedText;
    paired_at: string | Date;
    paired_by_name: string | null;
    last_seen_at: string | Date | null;
    revoked_at: string | Date | null;
    pin_locked_until: string | Date | null;
  }>(sql`
    select d.id, d.name, d.kind, b.name as branch_name, d.paired_at, p.display_name as paired_by_name, d.last_seen_at, d.revoked_at, d.pin_locked_until
    from app.devices d
    join app.branches b on b.tenant_id = d.tenant_id and b.id = d.branch_id
    left join app.staff p on p.tenant_id = d.tenant_id and p.id = d.paired_by
    order by (d.revoked_at is not null), d.paired_at desc, d.id`);
  const date = (v: string | Date | null) => (v ? new Date(v) : null);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    branchName: r.branch_name,
    pairedAt: new Date(r.paired_at),
    pairedBy: r.paired_by_name,
    lastSeenAt: date(r.last_seen_at),
    revokedAt: date(r.revoked_at),
    lockedUntil: date(r.pin_locked_until),
  }));
}

export interface ActivityRow {
  seq: number;
  occurredAt: Date;
  eventKey: string;
  actorKind: string;
  actorId: string | null;
  actorName: string | null;
  tableName: string | null;
  rowId: string | null;
  subjectId: string | null;
  subjectName: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/**
 * The shop's activity, newest first (the audit log in readable form). Needs `audit:view`.
 * `about` limits it to one person, device or other record. Page with `beforeSeq` = the last `seq` seen.
 */
export async function listActivity(tx: RlsTransaction, input: { limit?: number; beforeSeq?: number; about?: string } = {}): Promise<ActivityRow[]> {
  const rows = await tx.execute<{
    seq: string;
    occurred_at: string | Date;
    event_key: string;
    actor_kind: string;
    actor_id: string | null;
    actor_name: string | null;
    table_name: string | null;
    row_id: string | null;
    subject_id: string | null;
    subject_name: string | null;
    before_data: Record<string, unknown> | null;
    after_data: Record<string, unknown> | null;
  }>(sql`
    select seq, occurred_at, event_key, actor_kind, actor_id, actor_name, table_name, row_id, subject_id, subject_name, before_data, after_data
    from app.list_activity(${input.limit ?? 50}::int, ${input.beforeSeq ?? null}::bigint, ${input.about ?? null}::uuid)`);
  return rows.map((r) => ({
    seq: Number(r.seq),
    occurredAt: new Date(r.occurred_at),
    eventKey: r.event_key,
    actorKind: r.actor_kind,
    actorId: r.actor_id,
    actorName: r.actor_name,
    tableName: r.table_name,
    rowId: r.row_id,
    subjectId: r.subject_id,
    subjectName: r.subject_name,
    before: r.before_data,
    after: r.after_data,
  }));
}

/** The shop's main branch (new devices are connected to it for now). */
export async function getDefaultBranch(tx: RlsTransaction): Promise<{ id: string; name: LocalizedText } | null> {
  const rows = await tx.execute<{ id: string; name: LocalizedText }>(sql`select id, name from app.branches where is_default and archived_at is null limit 1`);
  return rows[0] ?? null;
}
