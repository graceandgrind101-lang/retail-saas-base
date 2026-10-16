import tseslint from "typescript-eslint";

/**
 * Shared ESLint flat config.
 *
 * Rule 1 (PLAN.md §2.4): `@retail/db/admin` bypasses row-level security. It may only be
 * imported by the console, by cron jobs, by packages/db itself and by scripts. Each
 * package says where it is allowed via `allowDbAdminIn` (globs relative to the package).
 *
 * Two entry points:
 *  - `createConfig(options)`: TypeScript preset + our rules. For plain packages.
 *  - `createRules(options)`:  our rules only. For apps whose own preset already brings
 *    typescript-eslint (apps/web uses eslint-config-next/typescript), so the plugin is
 *    not loaded twice.
 *
 * @typedef {object} Options
 * @property {string[]} [allowDbAdminIn] globs (relative to the package) allowed to import db.admin
 * @property {boolean} [allowDbAdminEverywhere] true for packages that are allowed wholesale
 * @property {string[]} [ignores] extra ignore globs
 */

export const GLOBAL_IGNORES = [
  "**/node_modules/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/dist/**",
  "**/.open-next/**",
  "**/next-env.d.ts",
];

/** @param {Options} [options] */
export function createRules(options = {}) {
  const { allowDbAdminIn = [], allowDbAdminEverywhere = false } = options;

  const dbAdminRule = {
    patterns: [
      {
        group: ["@retail/db/admin", "@retail/db/admin/*"],
        message:
          "db.admin bypasses row-level security. Only the console, cron jobs (jobs/), packages/db and scripts may import it. Use db.rls() for tenant data.",
      },
    ],
  };

  return [
    {
      files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
      rules: {
        "no-restricted-imports": allowDbAdminEverywhere ? "off" : ["error", dbAdminRule],
        "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
        "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      },
    },
    ...(allowDbAdminIn.length > 0 && !allowDbAdminEverywhere
      ? [{ files: allowDbAdminIn, rules: { "no-restricted-imports": "off" } }]
      : []),
  ];
}

/** @param {Options} [options] */
export function createConfig(options = {}) {
  const { ignores = [] } = options;
  return tseslint.config(
    { ignores: [...GLOBAL_IGNORES, ...ignores] },
    ...tseslint.configs.recommended,
    ...createRules(options),
  );
}
