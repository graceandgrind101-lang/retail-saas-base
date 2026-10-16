import { readFileSync, readdirSync } from "node:fs";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { describe, expect, it } from "vitest";
import config from "../drizzle.config";

// Schema drift is what broke the single-tenant reference app: `schema.sql` no longer matched
// the real database. These tests make that impossible here: a change to the TypeScript tables
// without a migration fails CI.

const metaDir = new URL("../migrations/meta/", import.meta.url);
const latestSnapshotFile = readdirSync(metaDir)
  .filter((f) => /^\d{4}_snapshot\.json$/.test(f))
  .sort()
  .at(-1);

// The files drizzle-kit reads, taken from the same list drizzle.config.ts uses, so this test
// can never drift from the config (a new table file is picked up automatically).
const configured = (Array.isArray(config.schema) ? config.schema : [config.schema ?? ""]).map((p) => p.split("/").at(-1) ?? "");

describe("schema drift", () => {
  it("has a snapshot for the latest migration", () => {
    expect(latestSnapshotFile).toBeDefined();
  });

  it("reads at least the platform and tenant-table definitions", () => {
    expect(configured).toEqual(expect.arrayContaining(["platform.ts", "tenant-table.ts"]));
  });

  it("the TypeScript tables match the latest migration snapshot (no migration is missing)", async () => {
    const snapshot = JSON.parse(readFileSync(new URL(latestSnapshotFile ?? "", metaDir), "utf8"));
    const modules = await Promise.all(
      configured.map((file) => import(`../src/schema/${file.replace(/\.ts$/, "")}`) as Promise<Record<string, unknown>>),
    );
    const current = await generateDrizzleJson(Object.assign({}, ...modules));
    const statements = await generateMigration(snapshot, current);
    expect(statements, "run `pnpm --filter @retail/db generate` and commit the new migration").toEqual([]);
  });
});

describe("what drizzle-kit is allowed to read", () => {
  const files = readdirSync(new URL("../src/schema/", import.meta.url)).filter((f) => f.endsWith(".ts"));
  const listed = (Array.isArray(config.schema) ? config.schema : [config.schema ?? ""]).map((p) => p.split("/").at(-1));

  it("never includes the audit log definition (its table is made by a hand-written migration)", () => {
    expect(listed).not.toContain("audit.ts");
  });

  it("lists every other schema file, so a new table file cannot be forgotten", () => {
    const readOnlyOrIndex = new Set(["audit.ts", "index.ts"]);
    const forgotten = files.filter((f) => !readOnlyOrIndex.has(f) && !listed.includes(f));
    expect(forgotten, `add to drizzle.config.ts schema: ${forgotten.join(", ")}`).toEqual([]);
  });
});
