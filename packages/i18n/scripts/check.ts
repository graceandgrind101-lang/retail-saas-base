import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkLocales, formatProblems } from "../src/check";
import { renderRegistry } from "../src/registry-source";

// CI: every language file complete and well formed, and the generated registry up to date.
// An optional folder argument lets tests run these scripts on a copy.
const root = process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url));
const codes = readdirSync(join(root, "messages"))
  .filter((file) => file.endsWith(".json"))
  .map((file) => file.slice(0, -".json".length))
  .sort();

const files: Record<string, unknown> = {};
let failed = false;
for (const code of codes) {
  try {
    files[code] = JSON.parse(readFileSync(join(root, "messages", `${code}.json`), "utf8"));
  } catch (error) {
    console.error(`i18n: messages/${code}.json is not valid JSON: ${error instanceof Error ? error.message : "parse error"}`);
    failed = true;
  }
}

if (!failed) {
  const problems = checkLocales(files);
  if (problems.length > 0) {
    console.error(`i18n: ${problems.length} problem(s) in the message files:\n${formatProblems(problems)}`);
    failed = true;
  }
  let current = "";
  try {
    current = readFileSync(join(root, "src", "generated", "registry.ts"), "utf8");
  } catch {
    // missing counts as out of date
  }
  if (current !== renderRegistry(codes)) {
    console.error("i18n: src/generated/registry.ts is out of date. Run `pnpm --filter @retail/i18n generate` and commit it.");
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`i18n: ${codes.length} language(s) OK (${codes.join(", ")})`);
