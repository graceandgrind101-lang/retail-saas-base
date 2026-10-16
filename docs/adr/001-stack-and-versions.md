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

## Findings from building A4 (database foundation)

- **TypeScript 6 no longer loads `@types/*` automatically** (`types` now defaults to nothing). Each package opts in: `packages/db` sets `"types": ["node"]`; `packages/core` deliberately sets none, which keeps it free of Node and DOM globals (it must stay pure).
- **esbuild install scripts denied** (`allowBuilds: esbuild: false`), same reasoning as `unrs-resolver`: they only swap a launcher for the native binary as a speed optimisation. `drizzle-kit` and `tsx` both run fine without them. `tsx` 4.23.15 added for running TypeScript scripts.
- **Never write Drizzle's breakpoint marker inside a comment** in a migration file. The runner splits on the literal text, even in a comment, and breaks the file mid-sentence (this happened). The marker is the two-dash, greater-than, "statement-breakpoint" comment.
- **PostgreSQL 16+: a non-superuser migration role cannot name `NOSUPERUSER`, `NOBYPASSRLS` or `NOREPLICATION` in `ALTER ROLE`.** A new role already has all of those off, so migration 0001 only sets `NOINHERIT`; the rest is asserted by the security check.
- **Postgres array equality includes the starting index.** `pg_index.indkey` is a zero-based vector, so comparing it with a one-based array always fails. The security check compares its text form instead.
- **Test ordering must never hide a bad migration.** Vitest runs previously failed files first, and one test grants then revokes a privilege to prove the checker notices. A weakened migration was therefore "repaired" by that test before another test looked at it, and a mutation slipped through. The fix: the freshly migrated test database is verified once in `global-setup.ts`, before any test runs, and the run aborts if it is not secure.
- **Mutation testing is part of how security rules are accepted** (CLAUDE.md). For A4, 12 deliberate weakenings of the migration and 8 of the TypeScript were applied one at a time and each had to be caught.

## Findings from building A5 (audit log)

- **drizzle-kit's `schemaFilter` does not stop it generating SQL for a table defined in TypeScript.** It only filters what is read from a live database. The audit table's TypeScript definition (for typed reading) was therefore picked up by `generate`, which tried to create `audit.log` a second time. `drizzle.config.ts` now lists schema files one by one and leaves `audit.ts` out; `schema-drift.test.ts` fails if that list is wrong, and also fails if a table is changed without a migration.
- **`SECURITY DEFINER` functions must pin `search_path`.** Otherwise anyone who can create an object earlier on the path can hijack them. The security check now fails any definer function in `audit`, `private` or `app` without it.
- **Row-level security on `audit.log` is enabled but not forced**, deliberately: the owner's definer functions are the only writers and must be able to insert even on a server where the owner does not have `BYPASSRLS` (the plain-Postgres case, D13).
- **A shop's request that writes should open with `{ write: true }`.** Without it, the first audited write takes the tenant lock after row locks are already held, and two writers touching rows in opposite orders can deadlock (SQLSTATE 40P01). Demonstrated in a test, then fixed in another.
- **Windows shell notes:** PowerShell strips double quotes from arguments passed to `docker exec`, so SQL containing JSON must be piped from a file; Python's `subprocess` needs `encoding="utf-8"` to read Vitest's output.

## Local development database

- **Image:** `supabase/postgres:17.11.0.003` (pinned; 17.11.0.004 existed but was two days old). Same Postgres build as Supabase cloud, so roles (`anon`, `authenticated`, `service_role`) and pgTAP behave as in production. Started with `pnpm db:up` from `infra/dev-db/compose.yaml`, bound to `127.0.0.1:54322` only.
- **Role facts verified on the running image:** `postgres` is not a superuser but has `BYPASSRLS`; `authenticated` has neither. Row-level security is therefore only enforced after `set local role authenticated`, which is what `db.rls()` does (DATA_MODEL M3). Tests must go through that wrapper, never connect as `postgres` and expect RLS to apply.
- **Why not the Supabase CLI for now:** A4-A6 need only Postgres. The CLI starts ~10 containers; we add it in A7 when Supabase Auth is needed.
- **Two containers:** `db` (dev data, port 54322, kept) and `db-test` (port 54323, in memory, wiped on stop). Tests only ever use `db-test`: they create a fresh database each run and set role passwords, and roles are shared by a whole Postgres server, so they must not share one with dev data.

## Not yet available on the dev machine

The Supabase CLI and the GitHub CLI are not installed (Docker now is). Git pushes use Git Credential Manager (browser sign-in), so the GitHub CLI is not needed.
