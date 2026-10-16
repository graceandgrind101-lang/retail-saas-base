import { sql } from "drizzle-orm";
import { newId, randomLetters } from "./helpers";
import type { LeakFixture } from "./leak-suite";

/**
 * One entry per table in the `app` schema. all-tables.test.ts fails if a table has no entry
 * here, which is how "every tenant table is covered by a cross-tenant leak test"
 * (CLAUDE.md) is enforced: add the table and its fixture in the same commit.
 *
 * A fixture returns one INSERT for a given tenant id. If the table needs a parent row, create
 * it in the same statement with a CTE. The statement is used both to seed two tenants and to
 * try to write into the wrong tenant, so it must work for any tenant id, and more than once
 * for the same tenant (hence the random keys).
 */
const role = (tenantId: string) =>
  sql`insert into app.roles (id, tenant_id, key, name) values (${newId()}, ${tenantId}, ${randomLetters()}, '{"en": "Role"}'::jsonb) returning id`;

/** A role, a staff member and a branch for the shop, in one statement; used by the device fixtures. */
const staffAndBranch = (tenantId: string) => sql`
  r as (${role(tenantId)}),
  s as (
    insert into app.staff (id, tenant_id, display_name, role_id, status)
    select ${newId()}, ${tenantId}, 'Staff member', id, 'active' from r returning id
  ),
  b as (
    insert into app.branches (id, tenant_id, name) values (${newId()}, ${tenantId}, '{"en": "Branch"}'::jsonb) returning id
  )`;

export const leakFixtures: Record<string, LeakFixture> = {
  branches: (tenantId) =>
    sql`insert into app.branches (id, tenant_id, name) values (${newId()}, ${tenantId}, '{"en": "Branch"}'::jsonb)`,

  roles: (tenantId) =>
    sql`insert into app.roles (id, tenant_id, key, name) values (${newId()}, ${tenantId}, ${randomLetters()}, '{"en": "Role"}'::jsonb)`,

  role_permissions: (tenantId) => sql`
    with r as (${role(tenantId)})
    insert into app.role_permissions (id, tenant_id, role_id, permission_key)
    select ${newId()}, ${tenantId}, id, 'product:view' from r`,

  staff: (tenantId) => sql`
    with r as (${role(tenantId)})
    insert into app.staff (id, tenant_id, display_name, role_id, status)
    select ${newId()}, ${tenantId}, 'Staff member', id, 'active' from r`,

  staff_sessions: (tenantId) => sql`
    with r as (${role(tenantId)}),
    s as (
      insert into app.staff (id, tenant_id, display_name, role_id, status)
      select ${newId()}, ${tenantId}, 'Staff member', id, 'active' from r returning id
    )
    insert into app.staff_sessions (id, tenant_id, staff_id, method, expires_at)
    select ${newId()}, ${tenantId}, id, 'password', now() + interval '1 day' from s`,

  devices: (tenantId) => sql`
    with ${staffAndBranch(tenantId)}
    insert into app.devices (id, tenant_id, branch_id, name, kind, token_hash, paired_by)
    select ${newId()}, ${tenantId}, b.id, 'Counter 1', 'pos', ${randomLetters(40)}, s.id from s, b`,

  device_pairing_codes: (tenantId) => sql`
    with ${staffAndBranch(tenantId)}
    insert into app.device_pairing_codes (id, tenant_id, created_by, branch_id, code_hash, expires_at)
    select ${newId()}, ${tenantId}, s.id, b.id, ${randomLetters(40)}, now() + interval '10 minutes' from s, b`,

  pin_verifications: (tenantId) => sql`
    with ${staffAndBranch(tenantId)}
    insert into app.pin_verifications (id, tenant_id, staff_id, requested_by, action_key, expires_at)
    select ${newId()}, ${tenantId}, s.id, s.id, 'sale:below_floor', now() + interval '2 minutes' from s`,
};
