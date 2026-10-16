import { describe, expect, it } from "vitest";
import { adminSql } from "./helpers";
import { leakFixtures } from "./leak-fixtures";
import { leakSuite } from "./leak-suite";

// Every real table in `app`, read from the migrated database itself. Sorting first makes the
// file order stable. Probe tables made by other test files are dropped before this runs.
const admin = adminSql(1);
const rows = await admin<{ name: string }[]>`
  select c.relname as name
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'app' and c.relkind in ('r', 'p')
  order by c.relname`;
await admin.end();

const tables = rows.map((r) => r.name);

describe("every tenant table is covered by a cross-tenant leak test (CLAUDE.md rule)", () => {
  it("has a fixture in test/leak-fixtures.ts for each table in the app schema", () => {
    const missing = tables.filter((t) => !(t in leakFixtures));
    expect(missing, `add a fixture for: ${missing.join(", ")}`).toEqual([]);
  });

  it("has no fixture for a table that no longer exists", () => {
    const stale = Object.keys(leakFixtures).filter((t) => !tables.includes(t));
    expect(stale, `remove the fixture for: ${stale.join(", ")}`).toEqual([]);
  });
});

for (const table of tables) {
  const fixture = leakFixtures[table];
  if (fixture) leakSuite(table, fixture);
}
