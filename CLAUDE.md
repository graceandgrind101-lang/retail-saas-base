# retail-saas: agent instructions

This is a multi-tenant retail POS SaaS for Ethiopian shops. **Current stage: Phase A (Foundation) is being built.** Progress and next task: [docs/PHASE_A_PLAN.md](docs/PHASE_A_PLAN.md). Later phases are still planning only.

## Read first, in this order
1. [docs/CONVERSATION_CONTEXT.md](docs/CONVERSATION_CONTEXT.md): how we got here, the owner's original 19 requests, and each decision with its reasoning.
2. [PLAN.md](PLAN.md): the master plan. Covers architecture, modules, settings, RBAC, feature specs, compliance, phases and open questions.
3. [RESEARCH.md](RESEARCH.md): research findings, with sources.
4. [docs/DATA_MODEL.md](docs/DATA_MODEL.md) (Phase A tables, approved) and [docs/DATA_MODEL_B.md](docs/DATA_MODEL_B.md) (Phase B sell & stock, approved). Screens: [docs/SCREENS.md](docs/SCREENS.md) (approved). Build order: [docs/PHASE_A_PLAN.md](docs/PHASE_A_PLAN.md).
5. [docs/reference/](docs/reference/): Planning Center UI screenshots (the dashboard look to modernise) and the original business case (`SaaS-Opportunity.md`).

## Ground rules
- **Phases:** the owner said "start Phase A" on 2026-10-16. Don't start Phase B or later until the owner says so. Update PLAN.md when decisions change, and record the decision in §0 or §10. Record progress in docs/PHASE_A_PLAN.md as tasks land.
- **Before finishing any task:** `pnpm run ci` and `pnpm build` must pass. Security and money rules need tests that fail when the rule is broken (we mutation-test them).
- **Never re-ask a decided question.** Decisions are in PLAN.md §0. Open questions are in PLAN.md §10.
- **Reference implementation:** `C:\Users\ytyir\OneDrive\Desktop\Projects\Neil Lewz` (single-tenant, live). Read it to port logic. **Do not modify it.**
- **Other projects we borrow patterns from (read only):**
  - `C:\Users\ytyir\OneDrive\Desktop\Projects\eecd-church`: settings, maker-checker, audit.
  - `C:\Users\ytyir\OneDrive\Desktop\Projects\GraceAndGrindNextGenV2\graceandgrindnextgenvii`: RBAC shape. Its enforcement has security holes; see RESEARCH.md §5.
- **Next.js:** pinned in `pnpm-workspace.yaml` (ADR-001: docs/adr/001-stack-and-versions.md). Read `apps/web/node_modules/next/dist/docs/` before writing Next code. APIs differ from training data: `proxy.ts` replaces middleware, `'use cache'`, and `revalidateTag(tag, 'max')`.
- **Mobile-first always:** design for 360px first.
- **Hosting:** free/cheap cloud tiers for now, no Ethiopian servers yet (D24). Keep everything portable so the later move is a config change.
- **Languages:** English is the default; Amharic is an option. **Calendar:** Gregorian by default, Ethiopian optional (D23). No user-facing text in code: it lives in message files (`en.json` is the source, `am.json` must have every key; `pnpm check:i18n` in CI enforces it). Adding a `<locale>.json` adds a language.
- **No SaaS brand name in code.** The brand is config. Neil Lewz will be tenant #1.
- **Money and security rules live in `packages/core`** and must be unit-tested. Core is pure: no I/O, no env, no DOM or Node types; it takes inputs as arguments.
- **Secrets:** never in code, docs, chat or git. Only `.env.example` files are tracked. The app refuses to boot on a missing or weak secret.
- **Trying it locally:** `pnpm db:up`, `pnpm dev:setup`, `pnpm dev:seed`, `pnpm dev` (the full walk-through is docs/GUIDE.md, the single document for setup, testing and how we work). Browser tests: `pnpm --filter @retail/web e2e` (needs `pnpm db:up`).
- **Shell:** PowerShell and bash both exist here. Long multi-line files are safer written with the Write tool than with bash heredocs.
- **Every tenant table** has `tenant_id` and RLS, and is covered by a cross-tenant leak test.

## Owner
- Yirael Tibebu (git: YiroNet29). Works in VS Code on Windows.
- Prefers discussing ideas, then getting a clear recommendation rather than a list of options.
