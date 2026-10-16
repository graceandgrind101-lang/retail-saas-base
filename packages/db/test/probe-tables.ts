import type { Sql } from "postgres";

/** The same shape `tenantTable()` produces, written as SQL for tests. */
export const STANDARD_COLUMNS_SQL = `
  id uuid primary key,
  tenant_id uuid not null references platform.tenants(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid`;

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
function assertIdentifier(name: string): void {
  if (!IDENTIFIER.test(name)) throw new Error(`unsafe identifier in test helper: ${name}`);
}

/** Create `app.<name>` like a real tenant table, and secure it with the production function. */
export async function createSecuredTable(
  admin: Sql,
  name: string,
  extraSql = "",
  options: { ignore?: string[]; redact?: string[] } = {},
): Promise<void> {
  assertIdentifier(name);
  const list = (columns: string[] = []) => `array[${columns.map((c) => `'${c.replace(/'/g, "''")}'`).join(", ")}]::text[]`;
  await admin.unsafe(
    `create table app.${name} (${STANDARD_COLUMNS_SQL}${extraSql ? `, ${extraSql}` : ""}, unique (tenant_id, id))`,
  );
  await admin.unsafe(
    `select private.secure_tenant_table('app.${name}', ${list(options.ignore)}, ${list(options.redact)})`,
  );
}

export async function dropTables(admin: Sql, ...names: string[]): Promise<void> {
  for (const name of names) {
    assertIdentifier(name);
    await admin.unsafe(`drop table if exists app.${name} cascade`);
  }
}

/** A parent and a child that references it with a composite key (DATA_MODEL M4). */
export async function createProbeTables(admin: Sql): Promise<void> {
  await createSecuredTable(admin, "probe_parent", "name text not null");
  await createSecuredTable(
    admin,
    "probe_child",
    "parent_id uuid not null, note text, foreign key (tenant_id, parent_id) references app.probe_parent (tenant_id, id)",
  );
}

export const dropProbeTables = (admin: Sql) => dropTables(admin, "probe_child", "probe_parent");
