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
};
