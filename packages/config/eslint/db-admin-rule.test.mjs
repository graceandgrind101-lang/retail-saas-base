import { Linter } from "eslint";
import { describe, expect, it } from "vitest";
import { createConfig } from "./index.mjs";

const code = `import { adminDb } from "@retail/db/admin";\nexport const x = adminDb;\n`;

function lint(config, filename) {
  const linter = new Linter({ configType: "flat", cwd: "/repo/apps/web" });
  return linter.verify(code, config, { filename });
}

describe("db.admin import rule (PLAN.md §2.4, Phase A task A1)", () => {
  const web = createConfig({ allowDbAdminIn: ["jobs/**"] });

  it("fails when apps/web/app imports db.admin", () => {
    const messages = lint(web, "app/page.tsx");
    expect(messages.some((m) => m.ruleId === "no-restricted-imports")).toBe(true);
  });

  it("fails for a server action as well", () => {
    const messages = lint(web, "app/(admin)/staff/actions.ts");
    expect(messages.some((m) => m.ruleId === "no-restricted-imports")).toBe(true);
  });

  it("allows cron jobs to import db.admin", () => {
    const messages = lint(web, "jobs/anchor-audit.ts");
    expect(messages.some((m) => m.ruleId === "no-restricted-imports")).toBe(false);
  });

  it("allows packages that are allowed wholesale (console, db)", () => {
    const messages = lint(createConfig({ allowDbAdminEverywhere: true }), "app/page.tsx");
    expect(messages.some((m) => m.ruleId === "no-restricted-imports")).toBe(false);
  });
});
