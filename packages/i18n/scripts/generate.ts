import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderRegistry } from "../src/registry-source";

// Lists messages/*.json and writes the module that imports them (see src/registry-source.ts).
// An optional folder argument lets tests run these scripts on a copy.
const root = process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url));
const codes = readdirSync(join(root, "messages"))
  .filter((file) => file.endsWith(".json"))
  .map((file) => file.slice(0, -".json".length));

mkdirSync(join(root, "src", "generated"), { recursive: true });
writeFileSync(join(root, "src", "generated", "registry.ts"), renderRegistry(codes), "utf8");
console.log(`i18n: ${codes.length} language file(s): ${codes.sort().join(", ")}`);
