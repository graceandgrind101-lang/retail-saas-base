// PLAN.md D5: no SaaS brand and no tenant name in code. The brand is config and
// "Neil Lewz" is tenant #1, so its name must never be hardcoded (Neil Lewz itself
// has ~25 files that do this). Docs under docs/ are not scanned.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const SCAN_DIRS = ["apps", "packages"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".turbo", "dist", ".open-next", ".wrangler", "coverage"]);
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css", ".sql", ".md"]);
const FORBIDDEN = /neil[\s._-]*lewz/i;

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else if (EXTENSIONS.has(extname(name))) files.push(full);
  }
  return files;
}

const hits = [];
for (const dir of SCAN_DIRS) {
  for (const file of walk(join(root, dir))) {
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (FORBIDDEN.test(line)) hits.push(`${relative(root, file)}:${i + 1}: ${line.trim()}`);
      });
  }
}

if (hits.length > 0) {
  console.error("Brand/tenant name found in code (PLAN.md D5). Move it to configuration:\n");
  console.error(hits.join("\n"));
  process.exit(1);
}
console.log("check:brand ok (no hardcoded brand or tenant names)");
