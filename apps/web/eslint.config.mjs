import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { createRules } from "@retail/config/eslint";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  // db.admin: only cron jobs under jobs/ and test files may import it (PLAN.md §2.4). Production code may not.
  ...createRules({ allowDbAdminIn: ["jobs/**", "test/**", "**/*.test.ts"] }),
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);
