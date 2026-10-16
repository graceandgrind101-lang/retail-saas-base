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

## Findings from building A6 (tenancy)

- **A drift test must read the same file list as the tool it guards.** `schema-drift.test.ts` first hard-coded which schema files to compare, so a new table file (`branches.ts`) made it report a phantom "DROP TABLE". It now derives the list from `drizzle.config.ts`.
- **A row-level BEFORE trigger that returns NULL cancels the row's operation.** The read-only trigger therefore must be statement-level (the security check pins `tgtype` 30, and a mutation that made it per-row is caught).
- **`UNIQUE NULLS NOT DISTINCT`** (Postgres 15+) is needed for "one platform default per key", because a plain unique constraint treats every NULL as different. drizzle-kit 0.31 generates it from `.nullsNotDistinct()`.
- **Custom migrations after generated ones:** `drizzle-kit generate` (tables) then `generate --custom` (functions, triggers, securing) keeps the order explicit: 0003 creates `app.branches`, 0004 secures it by re-running `secure_tenant_table()` over every existing tenant table. Every new version of that function must end the same way.
- **CLI tests on Windows:** `spawnSync` with `shell: true` does not quote arguments, so test arguments must not contain spaces.

## Findings from building A7a (sign-in)

- **Being `SECURITY DEFINER` does not exempt a function from a trigger.** The read-only trigger looks at the request's shop setting, so a definer function that updates a paused shop's table is still refused. `app.end_my_session` therefore clears the shop setting for its single UPDATE and restores it afterwards; a test checks the request is still inside its shop afterwards.
- **A made-up identity in a test must now be a real one.** Because every request that claims a staff id is checked against the database, the existing tests that used random ids failed, which is the secure default working. Tests use `createStaffSession()`; note that creating one is itself audited (three entries), so entry-count assertions are relative to a baseline.
- **`core` has two TypeScript projects.** `tsconfig.json` checks production code with NO Node or DOM types (core must stay pure); `tsconfig.test.json` adds Node for tests that cross-check with `node:crypto`. `pnpm typecheck` runs both.
- **Postgres custom error codes** (`RT001`-`RT003`, class "RT") carry application meanings (invitation invalid, already a member, no access) from the database to typed errors in `@retail/db`, alongside the standard `28000` ("sign in again") and `25006` ("shop is read-only").
- **Invitation tokens need no pepper or slow hash.** 256 random bits cannot be guessed, so plain SHA-256 is enough; the point of hashing is only that reading the database never yields a usable link.
- **The database owner needs `BYPASSRLS`** for the cross-shop definer functions (`my_shops`, `accept_invite`) to see rows (true for Supabase's `postgres`). On plain Postgres (D13) that attribute must be granted explicitly; recorded here so the later move to Ethiopian hosting does not trip on it.

## Local development database

- **Image:** `supabase/postgres:17.11.0.003` (pinned; 17.11.0.004 existed but was two days old). Same Postgres build as Supabase cloud, so roles (`anon`, `authenticated`, `service_role`) and pgTAP behave as in production. Started with `pnpm db:up` from `infra/dev-db/compose.yaml`, bound to `127.0.0.1:54322` only.
- **Role facts verified on the running image:** `postgres` is not a superuser but has `BYPASSRLS`; `authenticated` has neither. Row-level security is therefore only enforced after `set local role authenticated`, which is what `db.rls()` does (DATA_MODEL M3). Tests must go through that wrapper, never connect as `postgres` and expect RLS to apply.
- **Why not the Supabase CLI for now:** A4-A6 need only Postgres. The CLI starts ~10 containers; we add it in A7 when Supabase Auth is needed.
- **Two containers:** `db` (dev data, port 54322, kept) and `db-test` (port 54323, in memory, wiped on stop). Tests only ever use `db-test`: they create a fresh database each run and set role passwords, and roles are shared by a whole Postgres server, so they must not share one with dev data.

## Not yet available on the dev machine

The Supabase CLI and the GitHub CLI are not installed (Docker now is). Git pushes use Git Credential Manager (browser sign-in), so the GitHub CLI is not needed.

## Findings from building A7b (web sign-in)
- Next logs an error thrown from `instrumentation.ts` but keeps serving HTTP 500; the process must exit explicitly. `process.exit` is kept in `instrumentation-node.ts` (loaded only on Node) so the Edge analysis has nothing to warn about.
- postgres.js on `prepare:false` connections cannot serialise objects or `Date`: pass JSON as text with `::text::jsonb` and times as ISO strings with `::timestamptz`.
- Test database uses a fixed throwaway password; `@retail/db/testing` holds the shared helpers. `core` has no Node types, so its tests use `tsconfig.test.json`.
- Route files may only export HTTP verbs/config, so logic lives in `lib/auth` and a test checks every route file.

## Findings from building A8 (devices and PINs)
- A function that counts failed guesses must not raise on failure: the error rolls back the whole transaction, counter included. They return a status and the TypeScript helpers return `{ ok: false }` instead of throwing.
- PBKDF2 for PINs is capped at 100,000 iterations on Cloudflare Workers, and the PIN is first run through `HMAC(pepper, pin)` so a copy of the database alone cannot be brute-forced (4-6 digits is too few possibilities to protect otherwise).
- The PIN is checked in the server (slow hash), so the database counts each attempt as a failure first and a correct PIN clears it. This is what makes parallel guessing futile; a test fires 24 at once and only five get through.
- Audit rows name tables with their schema (`app.devices`). `created_at` is immutable; tests that need an expired code insert one directly.
- A lock on the till covers everyone on it, as the plan says (staff and device both lock after 5), so an owner/manager needs a way to open it early: `app.unlock_device`.
- Core has no Node or DOM types, so UTF-8 and base64url helpers live in `encoding.ts` and are reused by the PIN code.
- Windows: long bash heredocs containing quotes failed repeatedly; scripts are written with the Write tool and run with Python.

## Findings from building A9 (permissions)
- A trigger that checks `current_user` is how to say "only through the functions": inside a `SECURITY DEFINER` function it is the function's owner, in a direct statement it is `authenticated`. Unlike a transaction setting it cannot be set by the caller.
- The generic leak suite inserts parent rows (roles, staff) as the shop's own login, which the guards now refuse. Fixtures take parent rows made by the owner login, and a short list of "functions only" tables is asserted to refuse direct inserts instead.
- The last-owner rule needs a per-shop advisory lock: without it two owners demoting each other in parallel transactions both see the other still active (write skew). A test fires the race three times.
- Seeding the role templates writes about 90 audit rows per new shop (one per grant); the provisioning test computes the count from the templates.
- Tests that suspend "the owner" now need a second owner; a shared helper adds one.
- The permission registry holds keys of modules that are not built yet (dube, storefront, manufacturing, transfers), so owners get them automatically when those modules are switched on.

## Findings from building A10 (alerts)
- Alerts follow the same pattern as the permission tables: functions only, enforced by the `current_user` trigger, and listed in the leak suite's "functions only" set.
- `created_at` is immutable, so ordering tests insert an old alert directly rather than editing one.
- The lockout alert is raised where the lock is decided (inside `pin_attempt`), in the same transaction as the lock, so a lock without an alert cannot happen.
- Query strings are parsed strictly: an unknown, repeated or malformed parameter is a 400, never silently ignored.

## Findings from building A11 (languages and calendars)
- `next-intl` 4.14.9 works with Next 16 without path-based routing: one request config reads the language from a cookie. It pulls in `@parcel/watcher` and `@swc/core`, whose install scripts are denied like the earlier ones (prebuilt binaries are used).
- The language files are found at BUILD time and imported by a generated module, because Cloudflare Workers have no file system. The generated file is committed and CI fails if it is stale; the dev and build scripts regenerate it.
- The ICU parser from `@formatjs` is used for the placeholder check, so a translation's message syntax is validated exactly as the app will read it.
- The Ethiopian converter first came out one year and one day wrong: the leap day of the Ethiopian cycle falls in the third year, not the last, so the usual "four year cycle" shortcut is wrong. The year-from-day-count formula was replaced and the result is checked against `Intl` for every day of two centuries. My hand-written known dates were also wrong twice (New Year 2026 is 11 September; Adwa was 1 March), which the `Intl` cross-check exposed.
- `core` formats whole amounts without `.00` (`12,450 ETB`, as the screen spec shows); the formatter passes the option through for places that want two decimals.
- Language names are written in their own language in each file's `_meta`, so the picker needs no separate list.

## Findings from building A12 (UI kit)
- Plain CSS custom properties were chosen over Tailwind: no plugin or native binary to build, and a unit test can parse `tokens.css` and compute contrast. The first run of the contrast test passed everything except the dark-theme payment colours (solid chips too close to the dark surface); they were lightened and given dark text.
- A shop's brand being one hue keeps contrast guaranteed: the test sweeps twelve hues in both themes.
- Component tests run in jsdom with Testing Library; a real browser is still needed for layout, the hold gesture, focus and contrast, so Playwright runs the gallery at Pixel 7 and desktop sizes. `@axe-core/playwright` found a real problem on the first run (a page with no `<title>`); every page now gets a translated title.
- Chromium for Playwright is a ~150 MB download; a timed-out download leaves a half install that looks complete (the headless shell is missing). Re-run `playwright install chromium`.
- Playwright's mouse works in screen coordinates: a control below the fold must be scrolled into view before a raw mouse press.
- `<output>` elements have the `status` role, so a test for the toast region selects it by its class, not by role.
- `next-intl`, `@swc/core` and `@parcel/watcher` scripts stay denied; Playwright's own install script is denied too (browsers are installed explicitly).
- Mutation testing of the UI logic: 76 weakenings, 71 caught first time; 1 real gap (toast tone) got a test, 4 were redundant guards (for example an empty value plus "0" is "0" either way).
