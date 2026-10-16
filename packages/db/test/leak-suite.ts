import { randomBytes } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createAdminDb, type AdminDb } from "../src/admin";
import { runWithRls, type RlsContext, type RlsTransaction } from "../src/rls";
import * as schema from "../src/schema";
import { PG, adminSql, appSql, createTenant, expectPgError, newId, pgCode, randomLetters } from "./helpers";

/**
 * How to insert one valid row into a table for a given tenant. Self-contained: if the table
 * needs a parent row, the statement creates it too (a CTE), so it works for seeding AND as an
 * attack ("tenant A inserts a row that belongs to tenant B").
 */
export type LeakFixture = (tenantId: string, parents: LeakParents) => SQL;

/**
 * Rows a fixture may point at, made for each tenant by the OWNER login before the suite starts.
 * (A fixture cannot make them itself: some tables are written only through functions, so the
 * shop's own login may not insert a role or a staff member directly.)
 */
export interface LeakParents {
  roleId: string;
  staffId: string;
  branchId: string;
}

export interface LeakOptions {
  /**
   * The table is changed only through functions (migration 0010): the shop's own login must be
   * refused a direct insert, in its own shop as well as another's.
   */
  functionsOnly?: boolean;
}

const TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

/**
 * The cross-tenant leak test every tenant table must pass (CLAUDE.md: "covered by a
 * cross-tenant leak test"). Real tables register a fixture in test/leak-fixtures.ts and
 * all-tables.test.ts runs this suite for each.
 */
export function leakSuite(table: string, fixture: LeakFixture, options: LeakOptions = {}): void {
  if (!TABLE_NAME.test(table)) throw new Error(`unsafe table name: ${table}`);
  const qualified = `app.${table}`;

  describe(`cross-tenant leak: ${qualified}`, () => {
    let admin: Sql;
    let adminDb: AdminDb;
    // ONE connection (pool of 1) is used for everything below, both the raw SQL and the
    // wrapper. That is deliberate: it is the only way a settings leak between requests
    // (identity left on a reused connection) could ever show up.
    let app: Sql;
    let db: { rls<T>(ctx: RlsContext, fn: (tx: RlsTransaction) => Promise<T>): Promise<T> };
    let tenantA = "";
    let tenantB = "";
    let parentsA: LeakParents;
    let parentsB: LeakParents;

    async function makeParents(tenantId: string): Promise<LeakParents> {
      const parents = { roleId: newId(), staffId: newId(), branchId: newId() };
      await admin`insert into app.roles (id, tenant_id, key, name) values (${parents.roleId}, ${tenantId}, ${randomLetters()}, '{"en": "Role"}'::jsonb)`;
      await admin`insert into app.staff (id, tenant_id, display_name, role_id, status) values (${parents.staffId}, ${tenantId}, 'Staff member', ${parents.roleId}, 'active')`;
      await admin`insert into app.branches (id, tenant_id, name) values (${parents.branchId}, ${tenantId}, '{"en": "Branch"}'::jsonb)`;
      return parents;
    }

    const countFor = async (tenantId: string) => {
      const [row] = await admin.unsafe<{ n: number }[]>(`select count(*)::int as n from ${qualified} where tenant_id = $1`, [tenantId]);
      return row?.n ?? 0;
    };

    beforeAll(async () => {
      admin = adminSql();
      adminDb = createAdminDb(inject("adminUrl"));
      app = appSql(1);
      const drizzleOnSameConnection = drizzle(app, { schema });
      db = { rls: (ctx, fn) => runWithRls(drizzleOnSameConnection, ctx, fn) };
      const suffix = randomBytes(4).toString("hex");
      tenantA = await createTenant(admin, `leak-${suffix}-a`);
      tenantB = await createTenant(admin, `leak-${suffix}-b`);
      parentsA = await makeParents(tenantA);
      parentsB = await makeParents(tenantB);
      await adminDb.db.execute(fixture(tenantA, parentsA));
      await adminDb.db.execute(fixture(tenantB, parentsB));
    });

    afterAll(async () => {
      await app.end();
      await adminDb.close();
      await admin.end();
    });

    it("seeded rows for both tenants really exist (the test is not vacuous)", async () => {
      expect(await countFor(tenantA)).toBeGreaterThan(0);
      expect(await countFor(tenantB)).toBeGreaterThan(0);
    });

    it("retail_app gets permission denied if it forgets to switch role", async () => {
      await expectPgError(Promise.resolve(app.unsafe(`select count(*) from ${qualified}`)), PG.permissionDenied);
    });

    it("authenticated with no tenant context sees no rows", async () => {
      const rows = await app.begin(async (tx) => {
        await tx`set local role authenticated`;
        return tx.unsafe<{ n: number }[]>(`select count(*)::int as n from ${qualified}`);
      });
      expect(rows[0]?.n).toBe(0);
    });

    it("tenant A sees all of its own rows and none of B's", async () => {
      const rows = await db.rls({ tenantId: tenantA }, (tx) =>
        tx.execute<{ tenant_id: string }>(sql.raw(`select tenant_id from ${qualified}`)),
      );
      expect(rows.length).toBe(await countFor(tenantA));
      expect(rows.every((r) => r.tenant_id === tenantA)).toBe(true);
    });

    it("tenant A cannot see B's rows even when asking for them by name", async () => {
      const rows = await db.rls({ tenantId: tenantA }, (tx) =>
        tx.execute(sql.raw(`select * from ${qualified} where tenant_id = '${tenantB}'`)),
      );
      expect(rows.length).toBe(0);
    });

    it("tenant A cannot insert a row that belongs to tenant B", async () => {
      const before = await countFor(tenantB);
      await expectPgError(db.rls({ tenantId: tenantA }, (tx) => tx.execute(fixture(tenantB, parentsB))), PG.permissionDenied);
      expect(await countFor(tenantB)).toBe(before);
    });

    it(options.functionsOnly ? "tenant A cannot insert directly, even into its own shop (functions only)" : "tenant A can insert its own rows", async () => {
      const before = await countFor(tenantA);
      if (options.functionsOnly) {
        await expectPgError(db.rls({ tenantId: tenantA }, (tx) => tx.execute(fixture(tenantA, parentsA))), PG.permissionDenied);
        expect(await countFor(tenantA)).toBe(before);
        return;
      }
      await db.rls({ tenantId: tenantA }, (tx) => tx.execute(fixture(tenantA, parentsA)));
      expect(await countFor(tenantA)).toBe(before + 1);
    });

    it("tenant A cannot update B's rows", async () => {
      const touched = await db.rls({ tenantId: tenantA }, (tx) =>
        tx.execute(sql.raw(`update ${qualified} set updated_at = now() where tenant_id = '${tenantB}' returning id`)),
      );
      expect(touched.length).toBe(0);
    });

    it("tenant A cannot delete B's rows", async () => {
      const before = await countFor(tenantB);
      const removed = await db.rls({ tenantId: tenantA }, (tx) =>
        tx.execute(sql.raw(`delete from ${qualified} where tenant_id = '${tenantB}' returning id`)),
      );
      expect(removed.length).toBe(0);
      expect(await countFor(tenantB)).toBe(before);
    });

    it("tenant A cannot hand its row over to tenant B", async () => {
      const mine = await countFor(tenantA);
      const theirs = await countFor(tenantB);
      let failure: unknown;
      try {
        await db.rls({ tenantId: tenantA }, (tx) =>
          tx.execute(sql.raw(`update ${qualified} set tenant_id = '${tenantB}' where tenant_id = '${tenantA}'`)),
        );
      } catch (error) {
        failure = error;
      }
      expect(failure, "moving a row to another tenant must be an error").toBeDefined();
      expect([PG.checkViolation, PG.permissionDenied]).toContain(pgCode(failure));
      expect(await countFor(tenantA)).toBe(mine);
      expect(await countFor(tenantB)).toBe(theirs);
    });

    it("a request's identity does not leak into the next transaction on the same connection", async () => {
      await db.rls({ tenantId: tenantA }, async () => undefined);
      const rows = await app.begin(async (tx) => {
        await tx`set local role authenticated`;
        const [ctx] = await tx<{ tenant: string | null }[]>`select nullif(current_setting('app.tenant_id', true), '') as tenant`;
        const [count] = await tx.unsafe<{ n: number }[]>(`select count(*)::int as n from ${qualified}`);
        return { tenant: ctx?.tenant ?? null, n: count?.n };
      });
      expect(rows).toEqual({ tenant: null, n: 0 });
    });
  });
}
