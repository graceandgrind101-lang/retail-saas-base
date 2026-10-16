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

/** A column named like this holds a secret, so the audit log may only ever say "[redacted]". */
const SECRET_COLUMN_NAME = /(hash|token|secret|password)/i;

/** Personal details that must be redacted even though the name does not say "secret". */
const REQUIRED_REDACTIONS: Record<string, string[]> = {
  staff: ["pin_hash", "invite_token_hash", "phone", "invite_email"],
};

interface TableRow {
  name: string;
  rls: boolean;
  forced: boolean;
  has_tenant_id: boolean;
  has_composite_unique: boolean;
  has_tenant_fk: boolean;
  has_touch_trigger: boolean;
  has_audit_trigger: boolean;
  has_writable_trigger: boolean;
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
      -- AFTER, row-level, insert + update + delete (tgtype 1 + 4 + 8 + 16 = 29)
      exists (select 1 from pg_trigger g
              where g.tgrelid = c.oid and g.tgname = 'audit_row' and g.tgenabled = 'O'
                and g.tgtype = 29 and g.tgfoid = 'audit.record_row_change'::regproc) as has_audit_trigger,
      -- BEFORE, once per statement, insert + update + delete (tgtype 2 + 4 + 8 + 16 = 30):
      -- a paused or closed shop's session cannot change anything
      exists (select 1 from pg_trigger g
              where g.tgrelid = c.oid and g.tgname = 'enforce_writable' and g.tgenabled = 'O'
                and g.tgtype = 30 and g.tgfoid = 'private.assert_tenant_writable'::regproc) as has_writable_trigger,
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
    if (!table.has_writable_trigger) add(scope, "enforce_writable trigger is missing or disabled: a paused shop could still change this table");
    if (!table.has_audit_trigger) add(scope, "audit_row trigger is missing, disabled, or not AFTER INSERT/UPDATE/DELETE per row");
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

  // ── Secrets and personal details must never be written into the audit log ─
  // The log is append-only, so a secret that lands in it stays there forever. Any column that
  // looks like a secret must be redacted by the table's audit trigger, and the known personal
  // columns must be too (they could never be erased, PLAN.md §8). Re-running
  // secure_tenant_table() with its defaults (as a careless backfill migration might) would drop
  // these settings silently, which is exactly what this catches.
  const columns = await sql<{ table_name: string; column_name: string }[]>`
    select c.relname as table_name, a.attname as column_name
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app' and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped`;
  const triggerDefinitions = await sql<{ table_name: string; definition: string }[]>`
    select c.relname as table_name, pg_get_triggerdef(g.oid) as definition
    from pg_trigger g
    join pg_class c on c.oid = g.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app' and g.tgname = 'audit_row'`;
  for (const table of tables) {
    const definition = triggerDefinitions.find((t) => t.table_name === table.name)?.definition ?? "";
    const redacted = new Set([...definition.matchAll(/'redact:([a-z0-9_]+)'/g)].map((m) => m[1] ?? ""));
    const names = columns.filter((c) => c.table_name === table.name).map((c) => c.column_name);
    const mustRedact = new Set([
      ...names.filter((name) => SECRET_COLUMN_NAME.test(name)),
      ...(REQUIRED_REDACTIONS[table.name] ?? []),
    ]);
    for (const column of [...mustRedact].sort()) {
      if (!redacted.has(column)) add(`app.${table.name}`, `column ${column} is not redacted in the audit log`);
    }
  }

  // ── Schemas: who may use or create in each ───────────────────────────────
  const schemaRules: Record<string, { usage: string[] }> = {
    platform: { usage: [] },
    app: { usage: ["authenticated"] },
    private: { usage: ["authenticated"] },
    audit: { usage: ["authenticated"] }, // a shop may read its own entries
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

  await checkAuditLog(sql, add);

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

/** Functions a shop's own session may call in the audit schema. Everything else is owner-only. */
const TENANT_CALLABLE_AUDIT_FUNCTIONS = new Set(["record_event", "lock_tenant", "verify_own_chain"]);

async function checkAuditLog(sql: Sql, add: (scope: string, problem: string) => void): Promise<void> {
  // ── audit.log and audit.anchors: append-only, readable only as the policy allows ──
  for (const table of ["log", "anchors"] as const) {
    const scope = `audit.${table}`;
    const [row] = await sql<
      {
        rls: boolean;
        public_has_access: boolean;
        roles_with_access: string[] | null;
        authenticated_privs: string[] | null;
        owner_can_change: boolean;
      }[]
    >`
      select c.relrowsecurity as rls,
             exists (select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x where x.grantee = 0) as public_has_access,
             (select array_agg(r) from unnest(array['anon', 'service_role', 'retail_app']) r
               where has_table_privilege(r::name, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')) as roles_with_access,
             (select array_agg(p) from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
               where has_table_privilege('authenticated'::name, c.oid, p)) as authenticated_privs,
             has_table_privilege(c.relowner, c.oid, 'UPDATE, DELETE, TRUNCATE') as owner_can_change
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'audit' and c.relname = ${table}`;
    if (!row) {
      add(scope, "does not exist");
      continue;
    }
    if (row.public_has_access) add(scope, "PUBLIC has privileges");
    for (const role of row.roles_with_access ?? []) add(scope, `role ${role} has privileges`);
    const allowed = table === "log" ? ["SELECT"] : [];
    const extra = (row.authenticated_privs ?? []).filter((p) => !allowed.includes(p));
    if (extra.length > 0) add(scope, `authenticated has ${extra.join(", ")}`);
    if (table === "log" && !(row.authenticated_privs ?? []).includes("SELECT")) {
      add(scope, "authenticated cannot read its own entries");
    }
    if (row.owner_can_change) add(scope, "the owner still has UPDATE, DELETE or TRUNCATE (history could be edited)");
    if (table === "log" && !row.rls) add(scope, "row-level security is not enabled: one shop could read another's entries");
    if (table === "anchors" && row.rls) add(scope, "unexpected row-level security on an owner-only table");

    // The refusing triggers: rows BEFORE UPDATE/DELETE (tgtype 1+2+8+16 = 27), TRUNCATE BEFORE (2+32 = 34).
    const triggers = await sql<{ name: string; type: number; enabled: string }[]>`
      select g.tgname as name, g.tgtype::int as type, g.tgenabled as enabled
      from pg_trigger g where g.tgrelid = ('audit.' || ${table}::text)::regclass and not g.tgisinternal`;
    const find = (name: string) => triggers.find((t) => t.name === name);
    const rows = find(`audit_${table}_immutable_rows`);
    const truncate = find(`audit_${table}_immutable_truncate`);
    if (!rows || rows.type !== 27 || rows.enabled !== "O") add(scope, "append-only trigger for UPDATE/DELETE is missing or disabled");
    if (!truncate || truncate.type !== 34 || truncate.enabled !== "O") add(scope, "append-only trigger for TRUNCATE is missing or disabled");
  }

  // The only policy on audit.log lets a shop SELECT its own rows.
  const policies = await sql<{ name: string; cmd: string; roles: string[]; using_expr: string | null }[]>`
    select p.polname as name, p.polcmd as cmd,
           array(select rolname from pg_roles where oid = any(p.polroles) order by rolname) as roles,
           pg_get_expr(p.polqual, p.polrelid) as using_expr
    from pg_policy p where p.polrelid = 'audit.log'::regclass`;
  const only = policies[0];
  if (policies.length !== 1 || only?.name !== "tenant_read") {
    add("audit.log", `expected exactly one policy (tenant_read), found: ${policies.map((p) => p.name).join(", ") || "none"}`);
  } else {
    if (only.cmd !== "r") add("audit.log", "tenant_read must be a SELECT policy only");
    if (only.roles.join(",") !== "authenticated") add("audit.log", "tenant_read must apply to authenticated only");
    if (!EXPECTED_POLICY_EXPRESSIONS.has(normalize(only.using_expr))) {
      add("audit.log", `tenant_read USING is not tenant_id = ctx_tenant(): ${only.using_expr}`);
    }
  }

  // ── Functions in our schemas ─────────────────────────────────────────────
  const functions = await sql<
    { schema: string; name: string; definer: boolean; has_search_path: boolean; public_exec: boolean; authenticated_exec: boolean }[]
  >`
    select n.nspname as schema, p.proname as name, p.prosecdef as definer,
           coalesce(p.proconfig::text ilike '%search_path=%', false) as has_search_path,
           exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.grantee = 0) as public_exec,
           has_function_privilege('authenticated'::name, p.oid, 'EXECUTE') as authenticated_exec
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('audit', 'private', 'app')`;
  for (const fn of functions) {
    const scope = `function ${fn.schema}.${fn.name}`;
    // A SECURITY DEFINER function without a fixed search_path can be hijacked by anyone who can
    // create an object earlier on the path. Always pin it.
    if (fn.definer && !fn.has_search_path) add(scope, "SECURITY DEFINER without a fixed search_path");
    if (fn.public_exec) add(scope, "PUBLIC can execute it");
    if (fn.schema === "audit") {
      const meant = TENANT_CALLABLE_AUDIT_FUNCTIONS.has(fn.name);
      if (fn.authenticated_exec && !meant) add(scope, "a shop's session can execute an owner-only audit function");
      if (!fn.authenticated_exec && meant) add(scope, "a shop's session lost access to a function it needs");
    }
  }
}
