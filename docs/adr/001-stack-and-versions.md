# ADR-001: Stack and versions

- **Status:** accepted, 2026-10-16 (Phase A task A0; PLAN.md D25 B5)
- **Rule:** versions are pinned exactly in `pnpm-workspace.yaml` (`catalog:`). Bump deliberately, one at a time, with CI green. Re-read `node_modules/next/dist/docs/` after any Next upgrade.

## Pinned versions (checked on the npm registry on 2026-10-16)

| Tool | Version | Notes |
|---|---|---|
| Node | 24 (dev); `engines` >= 22 | Next needs >= 20.9; ESLint 10 needs >= 20.19 / 22.13 / 24 |
| pnpm | 12.11.2 | `packageManager` field |
| Turborepo | 2.11.8 | |
| Next.js | 16.4.2 | App Router, Turbopack default. `next lint` is removed: use the ESLint CLI. `next typegen` before `tsc` |
| React / React DOM | 19.3.1 | |
| TypeScript | **6.0.3** | See "Deviations" |
| ESLint / typescript-eslint | 10.12.0 / 8.71.2 | Flat config |
| Vitest | 5.0.5 | |
| Zod | 4.6.7 | |
| Drizzle ORM / Kit | 0.45.4 / 0.31.11 | Not used yet (task A4) |
| postgres (driver) | 3.4.9 | Not used yet (task A4) |
| Tailwind | 4.3.3 | Not used yet (task A12) |
| next-intl | 4.14.9 | Not used yet (task A11) |
| Playwright | 1.64.1 | Not used yet |

## Deviations from "latest" and why

1. **TypeScript 6.0.3, not 7.0.2.** `typescript-eslint@8.71.2` declares `typescript >=4.8.4 <6.1.0`, so TypeScript 7 would break linting. Next 16.4 itself supports TS 7 (docs: "Using TypeScript 7"), so revisit when typescript-eslint adds support.
2. **`unrs-resolver` install script denied.** It arrives through `eslint-config-next` -> `eslint-import-resolver-typescript`. Its `postinstall` (`napi-postinstall`) only matters when a platform's prebuilt binary is missing; lint works without it. Denied with `pnpm approve-builds '!unrs-resolver'`.
3. **pnpm 12 `minimumReleaseAgeExclude`.** pnpm 12 refuses very new package releases by default; it added the exact versions we pin (Next, Vitest, eslint-config-next and their native binaries) to the exclude list in `pnpm-workspace.yaml`. Those entries are exact versions, so nothing newer slips in. Review the list when bumping.

## Conventions

- Internal packages are `@retail/*` and ship TypeScript source (`exports` point at `src/`); `apps/web` transpiles them (`transpilePackages`).
- `@retail/db/admin` (RLS bypass) is only importable from `apps/console`, `jobs/`, `packages/db` and `scripts/`. Enforced by `@retail/config/eslint` and tested.
- `pnpm run ci` = brand check + lint + typecheck + tests. CI also runs `pnpm build`.
- `next dev` may add a managed block to `AGENTS.md` (Next's `agentRules`). Commit it if it appears.

## Findings from building A2

- **A failed `instrumentation.register()` does not stop `next start`.** Next logs the error, prints "Ready", keeps the process alive and answers every request with HTTP 500 (tested on 16.4.2). `register()` therefore calls `process.exit(1)` itself. Re-test this after any Next upgrade.
- **`next build` does not call `register()`**, so CI can build with no secrets.
- **`.env` files are read from `apps/web/`**, not the repo root. `NEXT_PUBLIC_*` values are frozen into the bundle at build time; server values are read at runtime.
- **OpenNext / Cloudflare (task week-2 deploy):** whether `register()` runs there is unverified. `serverEnv()` also validates on first use, so a bad environment still fails closed. Check this on the first Workers deploy.

## Local development database

- **Image:** `supabase/postgres:17.11.0.003` (pinned; 17.11.0.004 existed but was two days old). Same Postgres build as Supabase cloud, so roles (`anon`, `authenticated`, `service_role`) and pgTAP behave as in production. Started with `pnpm db:up` from `infra/dev-db/compose.yaml`, bound to `127.0.0.1:54322` only.
- **Role facts verified on the running image:** `postgres` is not a superuser but has `BYPASSRLS`; `authenticated` has neither. Row-level security is therefore only enforced after `set local role authenticated`, which is what `db.rls()` does (DATA_MODEL M3). Tests must go through that wrapper, never connect as `postgres` and expect RLS to apply.
- **Why not the Supabase CLI for now:** A4-A6 need only Postgres. The CLI starts ~10 containers; we add it in A7 when Supabase Auth is needed.

## Not yet available on the dev machine

The Supabase CLI and the GitHub CLI are not installed (Docker now is). Git pushes use Git Credential Manager (browser sign-in), so the GitHub CLI is not needed.
