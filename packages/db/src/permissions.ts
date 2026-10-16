import { sql } from "drizzle-orm";
import { isPermissionKey, resolvePermissions, type OverrideEffect, type PermissionKey } from "@retail/core";
import type { RlsTransaction } from "./rls";
import { getEnabledModules } from "./tenant-info";

/**
 * What a person may do, and changing who may do what (Phase A task A9, PLAN.md §5).
 *
 * Reading goes through core's ONE resolver, with inputs loaded fresh from the database on every
 * call: there is no cache, so a change takes effect on the next request. Writing goes through the
 * functions in migration 0010, which enforce the rules (only grant keys you hold, not your own,
 * not above you, never the last owner); the database refuses direct writes to these tables.
 */

/** What `staffId` may do right now in the request's shop; empty for someone unknown or not active. */
export async function getPermissionsOf(tx: RlsTransaction, staffId: string): Promise<Set<PermissionKey>> {
  const people = await tx.execute<{ role_id: string; role_key: string; status: string }>(sql`
    select s.role_id, r.key as role_key, s.status::text as status
    from app.staff s join app.roles r on r.tenant_id = s.tenant_id and r.id = s.role_id
    where s.id = ${staffId}::uuid`);
  const person = people[0];
  if (!person || person.status !== "active") return new Set();

  const granted = await tx.execute<{ permission_key: string }>(sql`select permission_key from app.role_permissions where role_id = ${person.role_id}::uuid`);
  const overrides = await tx.execute<{ permission_key: string; effect: OverrideEffect }>(
    sql`select permission_key, effect from app.staff_permission_overrides where staff_id = ${staffId}::uuid`,
  );
  return resolvePermissions({
    roleKey: person.role_key,
    rolePermissions: granted.map((g) => g.permission_key),
    overrides: overrides.map((o) => ({ key: o.permission_key, effect: o.effect })),
    enabledModules: await getEnabledModules(tx),
  });
}

/** What the signed-in person may do right now. */
export async function getMyPermissions(tx: RlsTransaction): Promise<Set<PermissionKey>> {
  const rows = await tx.execute<{ id: string | null }>(sql`select private.ctx_staff() as id`);
  const id = rows[0]?.id;
  return id ? getPermissionsOf(tx, id) : new Set();
}

export class PermissionDeniedError extends Error {
  readonly permission: string;
  constructor(permission: string) {
    super(`You do not have the permission ${permission}.`);
    this.name = "PermissionDeniedError";
    this.permission = permission;
  }
}

/** Throws `PermissionDeniedError` unless the signed-in person holds `key` (re-read from the database now). */
export async function requirePermission(tx: RlsTransaction, key: PermissionKey): Promise<void> {
  if (!(await getMyPermissions(tx)).has(key)) throw new PermissionDeniedError(key);
}

function checkedKey(key: string): PermissionKey {
  if (!isPermissionKey(key)) throw new TypeError(`unknown permission key: ${key}`);
  return key;
}

/** Add a person with no login account (a cashier): active at once, then give them a PIN. Run with `write: true`. */
export async function createStaff(
  tx: RlsTransaction,
  input: { id: string; displayName: string; roleId: string; phone?: string; branchIds?: string[] },
): Promise<string> {
  const branches = input.branchIds ? JSON.stringify(input.branchIds) : null;
  const rows = await tx.execute<{ id: string }>(sql`
    select app.create_staff(${input.id}::uuid, ${input.displayName}, ${input.roleId}::uuid, ${input.phone ?? null},
      case when ${branches}::text is null then null else array(select jsonb_array_elements_text(${branches}::text::jsonb)::uuid) end) as id`);
  return rows[0]?.id ?? input.id;
}

/** Give a person another role. Run with `write: true`. */
export async function setStaffRole(tx: RlsTransaction, staffId: string, roleId: string): Promise<void> {
  await tx.execute(sql`select app.set_staff_role(${staffId}::uuid, ${roleId}::uuid)`);
}

/** Give a custom role a key (or take it away). Run with `write: true`. */
export async function setRolePermission(tx: RlsTransaction, input: { roleId: string; key: string; granted: boolean }): Promise<void> {
  await tx.execute(sql`select app.set_role_permission(${input.roleId}::uuid, ${checkedKey(input.key)}, ${input.granted})`);
}

/** A personal exception for one person; a reason is required. Run with `write: true`. */
export async function setOverride(tx: RlsTransaction, input: { staffId: string; key: string; effect: OverrideEffect; reason: string }): Promise<void> {
  await tx.execute(sql`select app.set_override(${input.staffId}::uuid, ${checkedKey(input.key)}, ${input.effect}, ${input.reason})`);
}

/** Take a personal exception away. Returns false if there was none. Run with `write: true`. */
export async function removeOverride(tx: RlsTransaction, input: { staffId: string; key: string }): Promise<boolean> {
  const rows = await tx.execute<{ removed: boolean }>(sql`select app.remove_override(${input.staffId}::uuid, ${checkedKey(input.key)}) as removed`);
  return rows[0]?.removed === true;
}
