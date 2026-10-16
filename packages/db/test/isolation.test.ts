import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTenantDb, type TenantDb } from "../src/rls";
import { PG, adminSql, appUrl, createTenant, expectPgError, newId } from "./helpers";
import { leakSuite } from "./leak-suite";
import { createProbeTables, dropProbeTables } from "./probe-tables";

// Two probe tables stand in for real tenant tables until Phase A adds them. They are created
// with the same SQL function every real table must call, so this exercises the real mechanism.
const admin: Sql = adminSql();

await createProbeTables(admin);

leakSuite("probe_parent", (tenantId) =>
  sql`insert into app.probe_parent (id, tenant_id, name) values (${newId()}, ${tenantId}, 'parent')`,
);

// A child needs a parent in the same tenant; the CTE creates one, so the statement is
// self-contained. As an attack it fails on the parent insert, which is still the right outcome.
leakSuite("probe_child", (tenantId) => {
  const parentId = newId();
  return sql`
    with parent as (
      insert into app.probe_parent (id, tenant_id, name) values (${parentId}, ${tenantId}, 'parent') returning id
    )
    insert into app.probe_child (id, tenant_id, parent_id, note)
    select ${newId()}, ${tenantId}, id, 'child' from parent`;
});

describe("composite foreign keys (DATA_MODEL M4)", () => {
  let db: TenantDb;
  let tenantA = "";
  let tenantB = "";
  let parentA = "";
  let parentB = "";

  beforeAll(async () => {
    db = createTenantDb(appUrl(), { max: 1 });
    const suffix = randomBytes(4).toString("hex");
    tenantA = await createTenant(admin, `fk-${suffix}-a`);
    tenantB = await createTenant(admin, `fk-${suffix}-b`);
    parentA = newId();
    parentB = newId();
    await admin`insert into app.probe_parent (id, tenant_id, name) values (${parentA}, ${tenantA}, 'a'), (${parentB}, ${tenantB}, 'b')`;
  });

  afterAll(async () => {
    await db.close();
  });

  it("a child cannot point at another tenant's parent, even for the database owner", async () => {
    await expectPgError(
      Promise.resolve(
        admin`insert into app.probe_child (id, tenant_id, parent_id) values (${newId()}, ${tenantA}, ${parentB})`,
      ),
      PG.foreignKeyViolation,
    );
  });

  it("a child cannot point at another tenant's parent through the app either", async () => {
    await expectPgError(
      db.rls({ tenantId: tenantA }, (tx) =>
        tx.execute(sql`insert into app.probe_child (id, tenant_id, parent_id) values (${newId()}, ${tenantA}, ${parentB})`),
      ),
      PG.foreignKeyViolation,
    );
  });

  it("a child can point at its own tenant's parent", async () => {
    const id = newId();
    await db.rls({ tenantId: tenantA }, (tx) =>
      tx.execute(sql`insert into app.probe_child (id, tenant_id, parent_id) values (${id}, ${tenantA}, ${parentA})`),
    );
    const [row] = await admin<{ n: number }[]>`select count(*)::int as n from app.probe_child where id = ${id}`;
    expect(row?.n).toBe(1);
  });

  it("a row cannot reference a tenant that does not exist", async () => {
    await expectPgError(
      Promise.resolve(admin`insert into app.probe_parent (id, tenant_id, name) values (${newId()}, ${newId()}, 'orphan')`),
      PG.foreignKeyViolation,
    );
  });
});

describe("standard table behaviour (trigger)", () => {
  let tenant = "";
  let row = "";

  beforeAll(async () => {
    tenant = await createTenant(admin, `trg-${randomBytes(4).toString("hex")}`);
    row = newId();
    await admin`insert into app.probe_parent (id, tenant_id, name) values (${row}, ${tenant}, 'x')`;
  });

  it("updated_at moves forward on update and created_at never does", async () => {
    const [before] = await admin<{ created_at: Date; updated_at: Date }[]>`select created_at, updated_at from app.probe_parent where id = ${row}`;
    await new Promise((r) => setTimeout(r, 15));
    await admin`update app.probe_parent set name = 'y' where id = ${row}`;
    const [after] = await admin<{ created_at: Date; updated_at: Date }[]>`select created_at, updated_at from app.probe_parent where id = ${row}`;
    expect(after?.created_at.getTime()).toBe(before?.created_at.getTime());
    expect((after?.updated_at.getTime() ?? 0) > (before?.updated_at.getTime() ?? 0)).toBe(true);
  });

  it("id, tenant_id and created_at cannot be changed, not even by the owner", async () => {
    const other = await createTenant(admin, `trg-${randomBytes(4).toString("hex")}`);
    await expectPgError(Promise.resolve(admin`update app.probe_parent set id = ${newId()} where id = ${row}`), PG.checkViolation);
    await expectPgError(Promise.resolve(admin`update app.probe_parent set tenant_id = ${other} where id = ${row}`), PG.checkViolation);
    await expectPgError(Promise.resolve(admin`update app.probe_parent set created_at = now() - interval '1 day' where id = ${row}`), PG.checkViolation);
  });

  it("a row cannot be written with a hand-set updated_at", async () => {
    await admin`update app.probe_parent set updated_at = '2001-01-01', name = 'z' where id = ${row}`;
    const [r] = await admin<{ updated_at: Date }[]>`select updated_at from app.probe_parent where id = ${row}`;
    expect((r?.updated_at.getFullYear() ?? 0) > 2020).toBe(true);
  });
});

afterAll(async () => {
  await dropProbeTables(admin);
  await admin.end();
});
