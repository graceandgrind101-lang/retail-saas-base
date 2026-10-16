import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The real CI scripts, run on a throwaway copy of the package's messages: the done-when of A11.
const pkg = join(__dirname, "..");
let work = "";

const run = (script: "check" | "generate") => {
  try {
    const out = execFileSync(process.execPath, ["--import", "tsx", join(pkg, "scripts", `${script}.ts`), work], { cwd: pkg, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
};

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "i18n-"));
  mkdirSync(join(work, "src", "generated"), { recursive: true });
  cpSync(join(pkg, "messages"), join(work, "messages"), { recursive: true });
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

const messages = (name: string) => JSON.parse(readFileSync(join(work, "messages", `${name}.json`), "utf8")) as Record<string, unknown>;

describe("the CI scripts", () => {
  it("pass on the shipped files once the registry is generated", () => {
    expect(run("generate").code).toBe(0);
    const result = run("check");
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain("2 language(s) OK");
  });

  it("a language file dropped in without registering it fails CI, and generating adds it", () => {
    const xx = { ...messages("en"), _meta: { name: "Test language" } };
    writeFileSync(join(work, "messages", "xx.json"), JSON.stringify(xx));
    const stale = run("check");
    expect(stale.code).toBe(1);
    expect(stale.out).toContain("out of date");
    expect(run("generate").out).toContain("3 language file(s): am, en, xx");
    expect(readFileSync(join(work, "src", "generated", "registry.ts"), "utf8")).toContain('"xx": messages_xx');
    expect(run("check").code).toBe(0);
  });

  it("a missing key in a language fails CI and names it", () => {
    const am = messages("am");
    delete (am.common as Record<string, unknown>).save;
    writeFileSync(join(work, "messages", "am.json"), JSON.stringify(am));
    const result = run("check");
    expect(result.code).toBe(1);
    expect(result.out).toContain("am: common.save: is missing");
  });

  it("a broken placeholder fails CI", () => {
    const am = messages("en");
    am._meta = { name: "አማርኛ" };
    (am.alerts as Record<string, unknown>).open = "{total, plural, one {# ክፍት} other {# ክፍት}}";
    writeFileSync(join(work, "messages", "am.json"), JSON.stringify(am));
    const result = run("check");
    expect(result.code).toBe(1);
    expect(result.out).toContain("alerts.open");
    expect(result.out).toContain("{count:plural}");
  });

  it("a file that is not JSON fails CI", () => {
    writeFileSync(join(work, "messages", "am.json"), "{ not json");
    const result = run("check");
    expect(result.code).toBe(1);
    expect(result.out).toContain("not valid JSON");
  });

  it("a hidden, unfinished language does not fail CI", () => {
    writeFileSync(join(work, "messages", "am.json"), readFileSync(join(pkg, "messages", "am.json")));
    writeFileSync(join(work, "messages", "xx.json"), JSON.stringify({ _meta: { name: "Unfinished", hidden: true }, common: { yes: "x" } }));
    const result = run("check");
    expect(result.code, result.out).toBe(0);
  });
});
