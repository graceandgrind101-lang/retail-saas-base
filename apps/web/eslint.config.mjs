import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { createRules } from "@retail/config/eslint";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  // db.admin: only cron jobs under jobs/ may import it (PLAN.md §2.4).
  ...createRules({ allowDbAdminIn: ["jobs/**"] }),
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);
