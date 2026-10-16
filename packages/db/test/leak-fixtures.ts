import type { LeakFixture } from "./leak-suite";

/**
 * One entry per table in the `app` schema. all-tables.test.ts fails if a table has no entry
 * here, which is how "every tenant table is covered by a cross-tenant leak test"
 * (CLAUDE.md) is enforced: add the table and its fixture in the same commit.
 *
 * A fixture returns one INSERT for a given tenant id, for example:
 *
 *   branches: (tenantId) =>
 *     sql`insert into app.branches (id, tenant_id, name) values (${newId()}, ${tenantId}, '{"en":"Main"}')`,
 *
 * If the table needs a parent row, create it in the same statement with a CTE (see
 * isolation.test.ts). The statement is used both to seed two tenants and to try to write
 * into the wrong tenant, so it must work for any tenant id.
 */
export const leakFixtures: Record<string, LeakFixture> = {};
