# Phase A Build Plan: Foundation

> **Status:** **approved 2026-10-16** (PLAN.md D25). **Nothing starts until the owner says "start Phase A"** (CLAUDE.md).
> **Builds:** everything in [DATA_MODEL.md](DATA_MODEL.md) (approved D20), the shells and access screens from [SCREENS.md](SCREENS.md) (approved D22), i18n per SCREENS §0.1.
> **Assumes:** one developer working full-time with Claude Code. Estimates are in working days and include tests. Multiply by ~1.5 if part-time.

---

## 0. Approved choices

| # | Choice | Why |
|---|---|---|
| B1 | **Build only `apps/web` in Phase A.** `console`, `bot` and `verifier` start as empty folders. Pilot tenants are created with a **script** (`pnpm tenant:create`), not a console. | D11 says the console isn't in the pilot. A script is enough for 2–3 shops and saves about two weeks. |
| B2 | **Local Postgres in Docker (Supabase CLI) for development and tests**, Supabase cloud (free tier, D24) only for the deployed pilot. | pgTAP leak tests need a real database that can be reset in seconds. Costs nothing. Also keeps us honest about portability for the later Ethiopian migration (D13, D24). |
| B3 | **Tests come with each task, not at the end.** A task is done only when its "done when" checks pass in CI. | Leak tests and audit-chain tests are the exit criteria; leaving them to the end is how holes get in. |
| B4 | **Deploy from week 2**, not at the end. A preview deployment per branch on Cloudflare Workers. | Worker limits, `proxy.ts` quirks and OpenNext issues (RESEARCH §4) are better found early. Check vinext's status at that point (PLAN §2.2). This deploy also tells us whether the free Workers plan is enough or we need the $5 plan (PLAN §1). |
| B5 | **Verify library versions on day 1** (Next 16.4.x, Turborepo, Drizzle, next-intl, Tailwind, Zod) and read `node_modules/next/dist/docs/` before writing Next code. Record the versions in an ADR. | CLAUDE.md rule. APIs differ from older examples. |

---

## Progress (updated as work lands)

| Task | Status | Notes |
|---|---|---|
| A0 Pre-flight | ✅ done 2026-10-16 | ADR-001, pinned versions, pnpm, Docker Desktop, two local databases (`pnpm db:up`), private GitHub repo `MrSurfer/retail-saas-base` with pushes working, Cloudflare account created (first deploy is the week-2 milestone). Supabase CLI deliberately deferred to A7 |
| A1 Monorepo skeleton | ✅ done 2026-10-16 | `pnpm run ci` + `pnpm build` green; db.admin lint rule proven with real ESLint; brand check proven to fail on a planted violation |
| A2 Env and secrets | ✅ done 2026-10-16 | One Zod schema (`packages/core/src/env.ts`), boot hook (`apps/web/instrumentation.ts`), `.env.example`, `pnpm secrets:generate`. Verified on a real `next start`: no env → exit code 1 naming every missing variable; full env → HTTP 200; no secret value ever in logs. **Finding:** Next keeps a process alive after a failed boot hook (it just answers 500), so the hook now exits the process explicitly |
| A3 Core primitives | ✅ done 2026-10-16 | `packages/core`: `Santim` money (parse, format, sum), quantities in thousandths, one rounding rule (half away from zero), tax-inclusive extraction (per rate group), cash rounding, UUIDv7 (monotonic, injectable clock/random). 153 tests, hand-checked 15% VAT values, property tests, and 5 deliberately injected bugs all caught |
| A4 Database foundation | ✅ done 2026-10-16 | Drizzle + one migration runner (`pnpm db:migrate`); `platform.tenants` (moved up from A6: every tenant table references it); schemas `platform`/`app`/`audit`/`private`; `tenantTable()` helper; `private.secure_tenant_table()` (RLS on + forced, tenant policy, grants, updated_at trigger, immutable ids); request-context functions; `createTenantDb().rls()` and `@retail/db/admin`; limited login role `retail_app` (D26). **Verification:** 136 database tests, a generic leak suite every tenant table must pass, a catalog-reading security check that also runs before any test, and mutation testing (12 weakenings of the migration, 8 of the TypeScript; the first pass found two real holes in my own tests and both were fixed). **Deferred on purpose:** the audit-trigger requirement in the security check (A5) and the session/staff check inside `rls()` (A8) |
| A5 Audit log | ✅ done 2026-10-16 | Migration 0002: `audit.log` (one hash chain per tenant, gapless, in commit order), `audit_row` trigger attached to every tenant table by `secure_tenant_table()`, `record_event`, `verify_chain`/`verify_own_chain`/`verify_anchors`, write-once for everyone including the owner, secret columns redacted. `rls(ctx, fn, { write: true })` avoids a proven deadlock. Anchor job (`pnpm db:anchor`) with an R2 store. **Verification:** 232 database tests incl. 1,000 random writes, 8 concurrent writers, a "rogue DBA" suite (edit, relink, delete, recompute, full rewrite, tail deletion), a golden hash vector with an independent SHA-256; **53 deliberate weakenings, all caught**. **Open:** the real R2 bucket is wired in A16 (needs the owner to create it); the anchor store is verified against a local stand-in only |
| A6 Tenancy | ✅ done 2026-10-16 | Migrations 0003 (tables) and 0004 (functions): `platform.tenant_modules`, `platform.setting_policies`, `app.branches`; `app.my_tenant()` / `app.my_modules()` for a shop to read about itself; **paused/closed shops are read-only in the database** (D29); `pnpm tenant:create` / `provisionTenant()` (one transaction: shop, modules, default branch, audit event). Module registry in `@retail/core`. **Verification:** 329 db tests (82 new, plus the generic leak suite now running on `branches`); 30 more deliberate weakenings, all caught (83 in total for A4-A6 so far). **Scope change:** system roles and owner invite move to A7/A9 |
| A7a Sign-in: database side | ✅ done 2026-10-16 | Migrations 0005 (tables) and 0006 (functions): `app.roles`, `role_permissions`, `staff`, `staff_sessions`; `db.identity()` for a verified account before a shop is chosen; `app.my_shops` (shop picker), `app.accept_invite`, `app.start_session`, `app.end_my_session`; **every request that claims a session re-checks it in the same transaction, so suspending someone ends their session on the very next request (the A7 done-when)**; five system roles and the owner's invitation created with the shop (`pnpm tenant:create --owner-email`); invitation tokens stored only as hashes; personal contact details redacted from the audit log (D30). **Verification:** 461 db tests; 50 more deliberate weakenings, all caught (the first pass found two weak spots, both fixed). **Not yet:** the web server half below |
| A7b Sign-in: web server side | ✅ done | Verify the Supabase login token, signed session cookie, sign-in / shop-picker / sign-out / accept-invite endpoints |
| A8 Devices and PINs | ✅ done 2026-10-16 | Migrations 0007 + 0008, `db.device()`, `@retail/db` devices module, `/api/devices/*`, `/api/staff/pin`, `/api/step-up`; see PLAN D32. **Verification:** 28 core tests for the PIN rules, 47 database tests plus the leak suite for the three new tables, 21 web tests; mutation testing of the migration (47 weakenings: 39 caught at first, the 8 survivors each got a test that now fails without the rule) |

## 1. Tasks in order

| # | Task | Days | Done when |
|---|---|---|---|
| A0 | **Pre-flight:** private GitHub repo, version check (B5), Supabase CLI + Docker, Cloudflare account, ADR-001 "stack and versions" | 0.5 | ADR merged; `supabase start` runs locally |
| A1 | **Monorepo skeleton:** pnpm + Turborepo; `packages/config`, `core`, `db`, `ui`, `i18n`; `apps/web`; CI (lint, typecheck, unit tests). Lint rules: `db.admin` importable only from allowed paths; no brand name in code (D5) | 1 | CI green on an empty app; a test import of `db.admin` from `apps/web/app` fails lint |
| A2 | **Env and secrets:** one Zod schema for all env vars; separate secrets for session, PIN pepper, device-token pepper, reference pepper; app refuses to boot if any is missing | 0.5 | Boot test fails with a missing secret, passes with all set |
| A3 | **Core primitives** in `packages/core`: santim money type and formatting, UUIDv7, tax-inclusive extraction, rounding | 1 | Unit tests cover rounding edge cases and 15% VAT extraction |
| A4 | **Database foundation:** Drizzle + one migration runner; schemas `platform`, `app`, `audit`, `private`; a `tenantTable()` helper that adds standard columns, `unique (tenant_id, id)`, RLS + force + policy; `private.ctx_*()` functions; `db.rls()` and `db.admin` wrappers. **CI check:** every `app` table has RLS, force, policy, audit trigger and a leak test | 3 | A sample table: with no context, 0 rows; with tenant A's context, B's rows invisible and B inserts fail. The CI check fails when one is missing |
| A5 | **Audit log:** trigger, per-tenant advisory lock, hash chain, `audit.record_event()`, `audit.verify_chain()`, UPDATE/DELETE/TRUNCATE revoked and blocked, noise-column ignore list. Anchor script (writes chain head to R2) | 2 | Chain verifies after 1,000 random writes; editing one row (as superuser) breaks verification; UPDATE on `audit.log` fails |
| A6 | **Tenancy:** `platform.tenants`, `tenant_modules`, `setting_policies`, `app.branches`; `pnpm tenant:create` script (tenant + default branch + system roles + owner invite) | 1 | Script creates two tenants; leak tests pass for all tables so far |
| — | **Milestone 1 (end of week 2): data foundation.** Deploy a preview to Workers (B4) | | Leak tests and audit tests green in CI; preview URL loads |
| A7 | **Owner sign-in:** Supabase Auth (Google + email/password), link to `app.staff`, invite acceptance, shop picker, `staff_sessions`, sign-out and session revocation | 2 | Suspending a staff member ends their session on the next request (test) |
| A8 | **Devices and PINs:** pairing QR (one-time, 10 min), device token, PIN set and verify (HMAC pepper + PBKDF2), lockout of staff and device after 5 failures, PIN-only sessions (12 h), `pin_verifications` step-up tokens (single-use, 2 min, bound to an action), rate limits, lockout alert | 3 | PIN login works only on a paired device; revoked device is locked out; a step-up token can't be reused or used for another action |
| A9 | **Permissions:** key registry in `packages/core`, resolver (role ∪ allow − deny, limited to enabled modules), system role templates, overrides, last-owner constraint trigger, the GraceAndGrind-lesson rules (PLAN §5) | 2.5 | Unit tests for every rule; removing the last owner fails at the database level |
| A10 | **Alerts (minimal):** `app.alerts` table, `raiseAlert()` helper, basic list screen | 1 | PIN lockout and failed sign-ins appear as alerts |
| — | **Milestone 2 (end of week 4): who you are and what you may do** | | Cashier in tenant A can't see tenant B (Playwright + pgTAP) |
| A11 | **i18n:** next-intl; message files discovered from `packages/i18n/messages/`; English default, Amharic option; CI key-parity and placeholder check; money/number formatting; date display with Gregorian default and Ethiopian calendar option (conversion with tests, D23); language and calendar pickers | 1.5 | Dropping a test `xx.json` into `messages/` adds it to the picker after rebuild; a missing key in `am.json` fails CI |
| A12 | **UI kit:** design tokens (OKLCH, light/dark, pre-paint script), payment-method colours (U6), components: Button, Sheet, Tabs, Tile, Card, Toast, Keypad, PIN pad, Hold-to-confirm, Skeleton | 2.5 | Components render at 360px and desktop; contrast check (WCAG 4.5:1) passes for tokens |
| A13 | **Shells:** Admin shell (sidebar with module groups and CONFIGURATION, phone bottom tabs, right rail, shop switcher, Ctrl+K skeleton); POS shell (header, tabs, lock, idle auto-lock); impersonation banner placeholder | 2 | Playwright on Pixel 7 and desktop: navigation works, idle lock triggers |
| A14 | **Settings framework:** registry in `packages/core` (key, type, default, group, sensitive), `app.tenant_settings`, policy lookup (tenant → platform → default), settings screen with tabs in the URL, search, 🔒 badges, PIN prompt on sensitive sections, cache tag `settings:<tenant>` | 2 | Locked setting can't be saved even through a direct request; every save is in the audit log |
| A15 | **Staff, devices and activity screens:** staff list/detail, add staff, devices list + revoke, owner activity timeline, record timeline component | 2 | Owner can add a cashier, pair a device, and see both actions in Activity |
| A16 | **Exit pass:** full leak-test sweep, Playwright smoke (pair → PIN → shells → settings), audit chain verify, anchor script run against R2, docs updated | 1 | Exit criteria below all met |
| — | **Milestone 3 (end of week 6–7): Phase A done** | | |

**Total: about 31 working days ≈ 6–7 weeks.**

---

## 2. Exit criteria (PLAN §9, made testable)

1. A Cashier in tenant A cannot read or write tenant B's data: pgTAP on every table, plus a Playwright test through the real app.
2. The audit chain verifies for every tenant, and tampering is detected.
3. A PIN works only on a paired device, locks out after 5 failures, and every PIN approval is single-use and recorded.
4. The last Owner can't be removed; nobody can edit their own permissions or grant keys they don't hold.
5. A locked setting can't be changed by any route.
6. The app runs at 360px and on desktop in English and Amharic, and refuses to boot without its secrets.
7. A preview deployment on Workers passes the smoke test.

---

## 3. Honest timeline to the pilot

| Stretch | Estimate |
|---|---|
| Phase A | 6–7 weeks |
| Phase B (catalog, images, POS, shifts, returns, stock, serials, labels) | 6–8 weeks (rough; planned in detail before it starts) |
| Pilot slice of C (references, image hashes, review queue, basic Telegram alerts) | 2–3 weeks |
| **First pilot shop** | **about 3.5–4.5 months from "start Phase A"** |

The business case's "6–8 weeks for the MVP" (SaaS-Opportunity §6) predates the decisions on audit, RBAC, offline-readiness and the fraud shield. Those decisions are the product's selling points, so the longer timeline is the cost of them, not slippage. Ways to shorten it, if needed: a second developer from Phase B, or start the pilot shop on Phase B alone and add the payment checks a few weeks later.

---

## 4. Things to do in parallel (not code)

These have long lead times and can run while Phase A is being built:

1. **Partnership / legal entity** (PLAN §10 #2): needed before signing pilot shops.
2. **Lawyer engagement:** use [LAWYER_BRIEF.md](LAWYER_BRIEF.md).
3. **Collect 20+ real receipt screenshots per provider** (CBE, Telebirr, BOA…) for Phase C regex and OCR work.
4. **Recruit 2–3 electronics pilot shops** and agree what "pilot" means (free, for how long, what they give back).
5. ~~Hosting quotes~~ deferred (D24).
