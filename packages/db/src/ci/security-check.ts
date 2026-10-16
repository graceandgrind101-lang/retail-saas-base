import type { Sql } from "postgres";

/**
 * Asks the database itself whether the tenant-isolation rules hold, instead of trusting that
 * a migration author remembered them (CLAUDE.md: "every tenant table has tenant_id and RLS").
 * Run in CI by `pnpm --filter @retail/db check:db-security`, and by the test suite.
 */

export interface Violation {
  /** e.g. `app.sales`, `schema platform`, `role retail_app` */
  scope: string;
  problem: string;
}

const normalize = (expr: string | null) => (expr ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** What Postgres prints for `tenant_id = (SELECT private.ctx_tenant())`. */
const EXPECTED_POLICY_EXPRESSIONS = new Set([
  "(tenant_id = ( select private.ctx_tenant() as ctx_tenant))",
  "(tenant_id = (select private.ctx_tenant() as ctx_tenant))",
]);

interface TableRow {
  name: string;
  rls: boolean;
  forced: boolean;
  has_tenant_id: boolean;
  has_composite_unique: boolean;
  has_tenant_fk: boolean;
  has_touch_trigger: boolean;
  public_has_access: boolean;
  outside_roles_with_access: string[] | null;
  authenticated_extra_privs: boolean;
}

export async function checkDatabaseSecurity(sql: Sql): Promise<Violation[]> {
  const violations: Violation[] = [];
  const add = (scope: string, problem: string) => violations.push({ scope, problem });

  // ── Tables in `app` ──────────────────────────────────────────────────────
  const tables = await sql<TableRow[]>`
    select
      c.relname as name,
      c.relrowsecurity as rls,
      c.relforcerowsecurity as forced,
      exists (select 1 from pg_attribute a
              where a.attrelid = c.oid and a.attname = 'tenant_id' and a.attnotnull
                and not a.attisdropped and a.atttypid = 'uuid'::regtype) as has_tenant_id,
      -- indkey is a zero-based int2vector, so compare its text form ("2 1"), not as an array
      exists (select 1 from pg_index i
              where i.indrelid = c.oid and i.indisunique and i.indnkeyatts = 2
                and i.indkey::text =
                  (select attnum from pg_attribute where attrelid = c.oid and attname = 'tenant_id')::text
                  || ' ' ||
                  (select attnum from pg_attribute where attrelid = c.oid and attname = 'id')::text
             ) as has_composite_unique,
      exists (select 1 from pg_constraint k
              where k.conrelid = c.oid and k.contype = 'f'
                and k.confrelid = 'platform.tenants'::regclass
                and k.conkey = array[(select attnum from pg_attribute where attrelid = c.oid and attname = 'tenant_id')]
             ) as has_tenant_fk,
      exists (select 1 from pg_trigger g
              where g.tgrelid = c.oid and g.tgname = 'touch_updated_at' and g.tgenabled = 'O'
                and g.tgfoid = 'private.touch_updated_at'::regproc) as has_touch_trigger,
      exists (select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x
              where x.grantee = 0) as public_has_access,
      -- roles outside the policy that can still touch the table (inherited rights count)
      (select array_agg(r) from unnest(array['anon', 'service_role', 'retail_app']) r
        where has_table_privilege(r::name, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      ) as outside_roles_with_access,
      has_table_privilege('authenticated'::name, c.oid, 'TRUNCATE, REFERENCES, TRIGGER') as authenticated_extra_privs
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app' and c.relkind in ('r', 'p')
    order by c.relname`;

  const policies = await sql<
    { table_name: string; name: string; cmd: string; permissive: boolean; roles: string[]; using_expr: string | null; check_expr: string | null }[]
  >`
    select c.relname as table_name, p.polname as name, p.polcmd as cmd, p.polpermissive as permissive,
           array(select rolname from pg_roles where oid = any(p.polroles) order by rolname) as roles,
           pg_get_expr(p.polqual, p.polrelid) as using_expr,
           pg_get_expr(p.polwithcheck, p.polrelid) as check_expr
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app'`;

  for (const table of tables) {
    const scope = `app.${table.name}`;
    if (!table.has_tenant_id) add(scope, "no NOT NULL uuid tenant_id column");
    if (!table.has_tenant_fk) add(scope, "tenant_id is not a foreign key to platform.tenants(id)");
    if (!table.has_composite_unique) add(scope, "no unique (tenant_id, id) for composite foreign keys (DATA_MODEL M4)");
    if (!table.rls) add(scope, "row-level security is not enabled");
    if (!table.forced) add(scope, "row-level security is not FORCED");
    if (!table.has_touch_trigger) add(scope, "touch_updated_at trigger is missing or disabled");
    if (table.public_has_access) add(scope, "PUBLIC has privileges on this table");
    for (const role of table.outside_roles_with_access ?? []) add(scope, `role ${role} has privileges on this table`);
    if (table.authenticated_extra_privs) add(scope, "authenticated has TRUNCATE/REFERENCES/TRIGGER");

    const own = policies.filter((p) => p.table_name === table.name);
    const isolation = own.find((p) => p.name === "tenant_isolation");
    if (!isolation) {
      add(scope, "policy tenant_isolation is missing");
    } else {
      if (isolation.cmd !== "*") add(scope, "tenant_isolation does not cover ALL commands");
      if (!isolation.permissive) add(scope, "tenant_isolation is not permissive");
      if (isolation.roles.join(",") !== "authenticated") add(scope, `tenant_isolation applies to ${isolation.roles.join(",") || "nobody"}, expected authenticated`);
      if (!EXPECTED_POLICY_EXPRESSIONS.has(normalize(isolation.using_expr))) add(scope, `tenant_isolation USING is not tenant_id = ctx_tenant(): ${isolation.using_expr}`);
      if (!EXPECTED_POLICY_EXPRESSIONS.has(normalize(isolation.check_expr))) add(scope, `tenant_isolation WITH CHECK is not tenant_id = ctx_tenant(): ${isolation.check_expr}`);
    }
    for (const extra of own.filter((p) => p.name !== "tenant_isolation")) {
      add(scope, `unexpected policy ${extra.name}: another permissive policy could widen access`);
    }
  }

  // ── Schemas: who may use or create in each ───────────────────────────────
  const schemaRules: Record<string, { usage: string[] }> = {
    platform: { usage: [] },
    app: { usage: ["authenticated"] },
    private: { usage: ["authenticated"] },
    audit: { usage: [] }, // opened up by task A5
  };
  const everyone = ["anon", "authenticated", "service_role", "retail_app"];
  for (const [schema, rule] of Object.entries(schemaRules)) {
    const [exists] = await sql<{ n: number }[]>`select count(*)::int as n from pg_namespace where nspname = ${schema}`;
    if (!exists?.n) {
      add(`schema ${schema}`, "does not exist");
      continue;
    }
    const [pub] = await sql<{ usage: boolean; create: boolean }[]>`
      select exists (select 1 from aclexplode(coalesce(nspacl, acldefault('n', nspowner))) x where x.grantee = 0 and x.privilege_type = 'USAGE') as usage,
             exists (select 1 from aclexplode(coalesce(nspacl, acldefault('n', nspowner))) x where x.grantee = 0 and x.privilege_type = 'CREATE') as create
      from pg_namespace where nspname = ${schema}`;
    if (pub?.usage) add(`schema ${schema}`, "PUBLIC has USAGE");
    if (pub?.create) add(`schema ${schema}`, "PUBLIC has CREATE");
    for (const role of everyone) {
      const [priv] = await sql<{ usage: boolean; create: boolean }[]>`
        select has_schema_privilege(${role}::name, ${schema}::text, 'USAGE') as usage,
               has_schema_privilege(${role}::name, ${schema}::text, 'CREATE') as create`;
      const mayUse = rule.usage.includes(role);
      if (priv?.usage && !mayUse) add(`schema ${schema}`, `role ${role} has USAGE`);
      if (!priv?.usage && mayUse) add(`schema ${schema}`, `role ${role} lost USAGE it needs`);
      if (priv?.create) add(`schema ${schema}`, `role ${role} has CREATE`);
    }
  }

  // Nothing in `platform` is reachable by a tenant-facing role, table by table.
  const platformLeaks = await sql<{ table_name: string; role: string }[]>`
    select c.relname as table_name, r as role
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join unnest(array['anon', 'authenticated', 'service_role', 'retail_app']) r
    where n.nspname = 'platform' and c.relkind in ('r', 'p', 'v', 'm')
      and has_table_privilege(r::name, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')`;
  for (const leak of platformLeaks) add(`platform.${leak.table_name}`, `role ${leak.role} has privileges`);

  // ── Roles ────────────────────────────────────────────────────────────────
  const roles = await sql<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolinherit: boolean }[]>`
    select rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit
    from pg_roles where rolname in ('retail_app', 'authenticated', 'anon')`;
  for (const name of ["retail_app", "authenticated", "anon"]) {
    const role = roles.find((r) => r.rolname === name);
    if (!role) {
      add(`role ${name}`, "does not exist");
      continue;
    }
    if (role.rolsuper) add(`role ${name}`, "is a superuser");
    if (role.rolbypassrls) add(`role ${name}`, "has BYPASSRLS");
    if (role.rolcreatedb || role.rolcreaterole) add(`role ${name}`, "can create databases or roles");
  }
  const app = roles.find((r) => r.rolname === "retail_app");
  if (app?.rolinherit) add("role retail_app", "inherits privileges: forgetting db.rls() would not fail loudly");

  return violations;
}

export function formatViolations(violations: Violation[]): string {
  return violations.map((v) => `  - ${v.scope}: ${v.problem}`).join("\n");
}
