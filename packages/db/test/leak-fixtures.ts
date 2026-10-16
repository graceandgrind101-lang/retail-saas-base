import { sql } from "drizzle-orm";
import { newId, randomLetters } from "./helpers";
import type { LeakFixture } from "./leak-suite";

/**
 * One entry per table in the `app` schema. all-tables.test.ts fails if a table has no entry
 * here, which is how "every tenant table is covered by a cross-tenant leak test"
 * (CLAUDE.md) is enforced: add the table and its fixture in the same commit.
 *
 * A fixture returns one INSERT for a given tenant id. Rows it needs to point at (a role, a staff
 * member, a branch) come in as `parents`, made for that tenant by the suite. The statement is used
 * both to seed two tenants and to try to write into the wrong tenant, so it must work more than
 * once for the same tenant (hence the random keys).
 */

/**
 * Tables the shop's own login may not write directly: they change only through the functions that
 * enforce who may grant what (migration 0010). The suite checks a direct insert is refused.
 */
export const FUNCTIONS_ONLY_TABLES: ReadonlySet<string> = new Set(["roles", "role_permissions", "staff", "staff_permission_overrides", "alerts", "tenant_settings"]);

export const leakFixtures: Record<string, LeakFixture> = {
  branches: (tenantId) =>
    sql`insert into app.branches (id, tenant_id, name) values (${newId()}, ${tenantId}, '{"en": "Branch"}'::jsonb)`,

  roles: (tenantId) =>
    sql`insert into app.roles (id, tenant_id, key, name) values (${newId()}, ${tenantId}, ${randomLetters()}, '{"en": "Role"}'::jsonb)`,

  role_permissions: (tenantId, p) =>
    sql`insert into app.role_permissions (id, tenant_id, role_id, permission_key) values (${newId()}, ${tenantId}, ${p.roleId}, ${randomLetters() + ":view"})`,

  staff: (tenantId, p) =>
    sql`insert into app.staff (id, tenant_id, display_name, role_id, status) values (${newId()}, ${tenantId}, 'Staff member', ${p.roleId}, 'active')`,

  staff_sessions: (tenantId, p) =>
    sql`insert into app.staff_sessions (id, tenant_id, staff_id, method, expires_at) values (${newId()}, ${tenantId}, ${p.staffId}, 'password', now() + interval '1 day')`,

  staff_permission_overrides: (tenantId, p) =>
    sql`insert into app.staff_permission_overrides (id, tenant_id, staff_id, permission_key, effect, reason, granted_by)
        values (${newId()}, ${tenantId}, ${p.staffId}, ${randomLetters() + ":view"}, 'allow', 'test', ${p.staffId})`,

  devices: (tenantId, p) =>
    sql`insert into app.devices (id, tenant_id, branch_id, name, kind, token_hash, paired_by)
        values (${newId()}, ${tenantId}, ${p.branchId}, 'Counter 1', 'pos', ${randomLetters(40)}, ${p.staffId})`,

  device_pairing_codes: (tenantId, p) =>
    sql`insert into app.device_pairing_codes (id, tenant_id, created_by, branch_id, code_hash, expires_at)
        values (${newId()}, ${tenantId}, ${p.staffId}, ${p.branchId}, ${randomLetters(40)}, now() + interval '10 minutes')`,

  pin_verifications: (tenantId, p) =>
    sql`insert into app.pin_verifications (id, tenant_id, staff_id, requested_by, action_key, expires_at)
        values (${newId()}, ${tenantId}, ${p.staffId}, ${p.staffId}, 'sale:below_floor', now() + interval '2 minutes')`,

  alerts: (tenantId) =>
    sql`insert into app.alerts (id, tenant_id, category, rule_key, severity) values (${newId()}, ${tenantId}, 'info', 'test.note', 1)`,

  tenant_settings: (tenantId) =>
    sql`insert into app.tenant_settings (id, tenant_id, key, value) values (${newId()}, ${tenantId}, ${randomLetters() + ".note"}, '"x"'::jsonb)`,
};
