# Retail SaaS: Master Plan

> **Status:** planning only. No code yet.
> **Working name:** `retail-saas` (placeholder; the product needs a real name).
> **Date:** 2026-10-16
> **Reference implementation:** `Desktop/Projects/Neil Lewz`. It stays live and unchanged and becomes **tenant #1** later.
> **Research and sources:** see [RESEARCH.md](RESEARCH.md).

---

## 0. Decisions already made

| # | Decision | Choice |
|---|---|---|
| D1 | Start fresh or refactor Neil Lewz | **Fresh monorepo.** Port proven logic from Neil Lewz module by module: receipt parser, OCR flow, FEFO stock procedures, scanner hooks, labels, PIN sessions. |
| D2 | Tenant addresses | **Subdomain per shop for storefronts** (`natimobile.<domain>`). Admin and POS on one domain (`app.<domain>`) with a shop switcher. |
| D3 | SaaS console | **Separate app** (`console.<domain>`), separate login, separate deploy. The master key lives only here. |
| D4 | Sale below floor price | **Allowed only with a manager PIN, then flagged.** |
| D5 | Branding | **No SaaS name in code.** Brand is config. Neil Lewz is client #1. |
| D6 | Device priority | **Mobile-first everywhere.** Design at 360px first; tables become cards; admin gets a bottom tab bar on phones; the POS works one-handed. |
| D7 | Settings | **Most settings locked at launch.** Each setting is Editable, Locked, or Hidden per tenant, controlled from the console (§4). |
| D8 | Payment reference | **Required for every digital payment**, from QR/link, OCR, or manual entry (flagged "manual"). Fraud protection is the headline selling point. |
| D9 | Referral tiers | **Front-loaded**: 5 × 5%, then 5 × 3.5%, then 5 × 1.5%, capped at 50%. Plus a one-time two-sided reward (§7.12). |
| D10 | Storefront / SEO | **Off by default.** Three modes: Off, Private (link only, noindex), Public. |
| D11 | Pilot scope | **Pilot = Phase A + B + a thin slice of C** (§9): catalog with IMEI/serial, POS, Z report, floor-price PIN, audit log, reference registry with same-shop duplicate check and image hash, manual review queue, basic Telegram alerts. **Electronics shops first.** Mini-markets only after Phase F (offline), because they can't fall back to paper during an outage. |
| D12 | Pricing (starting point) | **No Lite tier.** Two tiers, both with the fraud shield: **Pro ~2,000 ETB/mo**, **Business ~5,000 ETB/mo** (multi-staff, serials, priority support). **Onboarding fee 10k–25k ETB scaled by item count**, waived for pilots. Validate with the first 5 shops. |
| D13 | Hosting approach | **Build portable, as if the answer is option B** (plain Postgres features only, no Supabase-only logic), so a later move to Ethiopian servers is a config change. The pilot runs on Supabase cloud with signed pilot consent. See D24. |
| D14 | Ethiopian hosting quotes | ~~Ethio Telecom Tele Cloud and Wingu.Africa.~~ **Deferred by D24.** These remain the providers to quote when the migration comes. |
| D15 | Field onboarding | **Owner onboards the first 5 shops personally**, then hire reps. An `onboarder` platform role exists from day one: catalog only, time-limited access to a tenant, logged. |
| D16 | Neil Lewz | **Stays entirely on the old app until Phase G.** One business is never split across two systems. |
| D17 | Self-pay discount | **Funded by the shop, default 3%, cap 5%** (locked setting). We never fund it: the cost would grow with every shop's sales volume, and paying money tied to payments moves us toward the NBE licence problem (§8). |
| D18 | Manager PIN while offline | **PIN hashes never leave the server.** A below-floor sale (or any other PIN action) made offline is saved as `pending_approval`, raises a Suspicion alert, and is settled once the device syncs. |
| D19 | Domain | **A `.com` as the main domain** (Cloudflare for SaaS); register the `.et` for defence. The name does not block Phase A because the brand is config. |
| D20 | Phase A data model | **Approved:** choices M1–M9 in [docs/DATA_MODEL.md](docs/DATA_MODEL.md) §0. These include PIN-only cashiers on paired devices, a server-set tenant context, composite tenant FKs, money stored in santim, and one audit chain per tenant. |
| D21 | Phase B data model | **Approved:** choices S1–S9 in [docs/DATA_MODEL_B.md](docs/DATA_MODEL_B.md) §0. These include the variant as the unit you sell and stock, the ledger as the source of truth with negative stock allowed, per-device receipt numbers, server recompute that flags instead of rejecting, immutable sales (void or return only), and unique references per tenant. |
| D22 | Screen map and language | **Approved:** U1–U8 in [docs/SCREENS.md](docs/SCREENS.md) §0, with one change by the owner: **English is the default language**, Amharic is an option. All UI text comes from message files (`en.json`, `am.json`, …); adding a file adds a language. Includes two shells (POS/Admin), the 3-touch cash sale, a 10-second undo, floor price hidden from cashiers, and Home trends vs the same weekday last week. |
| D23 | Calendar | **Gregorian by default.** The Ethiopian calendar is an option (shop setting, and per user). Dates are always stored in Gregorian UTC. Supersedes the calendar part of D22/U7. |
| D24 | Hosting for now | **No Ethiopian servers for now** (owner decision): Ethiopian providers have no free tier. Build and run the working product on **free/cheap cloud tiers** (Supabase, Cloudflare). Migrate to Ethiopian servers later, when needed. The code stays portable (D13), which keeps that migration a config change. Supersedes D14 (quotes deferred). Consequences: Telebirr and M-Pesa receipt lookups, which only answer Ethiopian IPs, wait for the migration; CBE, BOA and Dashen lookups can be tried from abroad in Phase C. |
| D25 | Phase A build plan | **Approved:** B1–B5 in [docs/PHASE_A_PLAN.md](docs/PHASE_A_PLAN.md) §0: only `apps/web` in Phase A, pilot tenants created by script, local Docker database for dev/tests, tests written with each task, deploy from week 2, versions checked on day 1. |
| D26 | App database login | **Refines DATA_MODEL M3 (found while building A4).** The shop app logs in as a limited role, `retail_app`: no `BYPASSRLS`, no inherited rights, no privileges until a request switches to `authenticated` inside `db.rls()`. Forgetting the wrapper gives a loud "permission denied", never another shop's data. The owner login (`postgres`) is used only for migrations, scripts and `db.admin`, and its URL (`DATABASE_ADMIN_URL`) is never given to the web app. `DATABASE_URL` for the web app is the `retail_app` URL. |
| D27 | Isolation tests | **Replaces "pgTAP" in the plan.** Cross-tenant leak tests are Vitest tests against a real Postgres (the same Supabase image), driven through the real `db.rls()` wrapper, with a generic leak suite that every tenant table must pass. They run on a separate throwaway test database container so they never touch dev data or share its roles. A CI check reads the database catalog itself (RLS on, forced, the exact policy, grants, schema lockdown) and every `app` table must have a leak fixture. Why not pgTAP: one runner, TypeScript-native, no psql dependency on CI, and it exercises the actual wrapper. |
| D28 | Audit log design | **Built in A5** (details in DATA_MODEL §3.3). Recording is done by a database trigger on every tenant table, attached by `secure_tenant_table()`, so it cannot be forgotten. One hash chain per tenant, gapless and in commit order. Nobody, **including the database owner**, has UPDATE/DELETE/TRUNCATE on it, and triggers refuse too. Secret columns are recorded as "[redacted]". Anchors (chain heads copied outside the database) catch what a chain alone cannot: newest entries deleted, or the whole history rewritten. Write transactions use `db.rls(ctx, fn, { write: true })` to avoid a deadlock. The Cloudflare R2 bucket for anchors is wired at the end of Phase A (A16) once the owner creates it; until then the job is tested against an in-memory store and a fake HTTP server. |
| D29 | Paused shops and shop creation | **Built in A6.** A `paused` or `closed` shop can read everything and change nothing: enforced in the database by a trigger on every tenant table, so no application code can forget it (nothing is ever deleted; reactivating restores writing at once; `past_due` is only a warning). Platform code with no shop context is not blocked, so support can still recover a shop. A shop is created by one command, `pnpm tenant:create`, in one transaction: shop, starter modules for its industry, default branch, audit entry. **Scope change:** system roles and the owner invitation were listed under A6 but need the staff and role tables, so they move to A7 and A9, where the same command is extended. |

---

## 1. Product positioning (revised after research)

**The pricing problem.** Bileh Tracker (bileh.com) already sells Amharic, offline, Ethiopian-calendar, Dube, Z-report and multi-branch POS for **400–600 ETB/month**. Our draft pricing (3,500–12,000 ETB/mo plus 25k–75k setup) has to be justified by things Bileh does **not** do:

1. **Payment fraud shield.** Reference uniqueness across the whole platform, perceptual hashing of screenshots, and **lookup against the bank's own receipt** (CBE, Telebirr, BOA, Dashen…). Bileh only attaches a screenshot.
2. **Done-for-you onboarding plus a Master Catalog.** We register 300+ items for them, with photos, in a day.
3. **Theft control.** Floor prices, discount enforcement, a tamper-evident audit log, the alerts center, and shift close with counted cash.
4. **Vertical depth.** IMEI/serial plus warranty for electronics; lots and expiry for cosmetics and mini-markets; wholesale price tiers for Merkato.
5. **A professional Telegram bot** for owners: approvals, alerts, daily close, Dube reminders.

**Pricing:** decided as a starting point in D12 (no Lite tier; Pro ~2,000, Business ~5,000 ETB/mo, plus an onboarding fee). One fake screenshot on a phone sale costs a shop more than a year of Pro. Validate the price with the first 5 shops.

**Running costs by stage (D24: free tiers first; re-check limits and prices before relying on them):**

| Item | Development | Pilot (2–3 shops) | Paid launch |
|---|---|---|---|
| Supabase | Free (local Docker + free cloud project) | Free: 500 MB database is plenty for 2–3 shops. **Limits:** pauses after a week of no activity (a shop selling daily keeps it awake), and no managed backups (our nightly `pg_dump` to R2 covers this, §7.14) | Pro, $25: daily backups, no pausing |
| Cloudflare Workers | Free | **Paid, $5.** The free plan's CPU limit per request (about 10 ms) is likely too small for Next.js page rendering. Confirm with the week-2 preview deploy | $5 + usage |
| R2 (images, backups) | Free (10 GB) | Free | $0–10 |
| PowerSync (Phase F) | Free dev tier | — (offline not in pilot) | Pro $49, or self-host the Open Edition |
| Sentry / PostHog | Free | Free | Free tiers |
| Ethiopian hosting | — | — | Later (D24) |
| **Total** | **$0** | **≈ $5/mo** | **≈ $80–90/mo (≈ 13–15k ETB)** |

At paid launch that is about **7–8 Pro shops to break even** on infrastructure, before support time. Point-in-time recovery (+$100/mo) is not included.

**Launch verticals:** electronics/phones and mini-markets (per *SaaS Oportunity.md*). Cosmetics third.

---

## 2. Architecture

### 2.1 Monorepo layout

```
retail-saas/
├── apps/
│   ├── web/          # tenant admin + POS + storefront (subdomains)
│   ├── console/      # platform console (us only), separate deploy
│   ├── bot/          # Telegram bot (grammY), separate worker
│   ├── verifier/     # receipt verification worker; must move to Ethiopia for Telebirr (D24)
│   └── mobile/       # later: Capacitor wrapper of the POS
├── packages/
│   ├── core/         # pure business rules: pricing, floor/discount, fraud flags,
│   │                 # receipt parsing, permissions, money math. No I/O, 100% unit-tested.
│   ├── db/           # Drizzle schema, migrations, RLS wrapper (db.rls / db.admin)
│   ├── ui/           # design system (Tailwind 4 + Radix/shadcn-style), tokens, icons
│   ├── i18n/         # message files (en, am, …), Ethiopian calendar helpers (optional display)
│   └── config/       # eslint, tsconfig, tailwind presets
└── docs/             # PLAN.md, RESEARCH.md, ADRs, runbooks
```

### 2.2 Stack

| Layer | Choice | Notes |
|---|---|---|
| Monorepo | pnpm + Turborepo 2.11 | |
| Framework | **Next.js 16.4** (latest stable; Next 17 does not exist yet), React 19.3, TypeScript | Read `node_modules/next/dist/docs` before coding. `proxy.ts` replaces middleware. |
| Database | Supabase Postgres + Auth + RLS | Must stay **portable**: Supabase can be self-hosted, which matters for §2.3. |
| Schema | **Drizzle ORM with versioned migrations** | Fixes Neil Lewz's schema drift. One migration runner only. |
| UI | Tailwind 4.3 (OKLCH tokens) + Radix-based components | Theme = CSS variables per tenant. |
| Validation | Zod 4 | Same schemas in the browser, server and bot. |
| i18n | next-intl 4. **English default**, Amharic option, Afaan Oromo later. Languages are message files (`en.json`, `am.json`) discovered at build time ([docs/SCREENS.md](docs/SCREENS.md) §0.1) | **Gregorian by default**, Ethiopian calendar optional (D23); store dates in Gregorian UTC. |
| Images | Cloudflare R2 + client-side editing/compression | See §7.7. |
| Offline | **PowerSync** (Supabase-native, SQLite in the browser, Capacitor SDK) + `@serwist/turbopack` | Fallback: Dexie + outbox if budget is tight. |
| OCR | tesseract.js 7 in the browser → Workers AI vision as fallback | OCR is never proof; the bank lookup is. |
| Bot | grammY | HTML mode, `<code>` tap-to-copy. |
| Hosting | Cloudflare Workers via OpenNext, **kept portable** | Cloudflare now steers new apps to "vinext" (beta). Keep platform APIs behind `packages/core` interfaces so moving to Vercel, vinext or a Node server in Ethiopia is a config change. |
| Quality | Vitest, Playwright (Pixel-7 emulation, offline mode), database leak tests (Vitest on real Postgres, D27), Sentry (client), PostHog | |

### 2.3 ⚠️ Hosting location (deferred by D24; must be answered before paid launch)

> **Current approach (D24):** build and run on free/cheap cloud tiers, keep everything portable, migrate to Ethiopian servers later. The legal question below still has to be answered before charging shops, so we know *when* the migration must happen.

The Personal Data Protection Proclamation **1321/2024, Art. 22** says personal data collected in Ethiopia must be stored on servers **located in Ethiopia**. Commentators disagree on whether that means "only in Ethiopia" or "a copy in Ethiopia". Penalties for unlawful transfer abroad are severe (Art. 64). Telebirr receipt pages also only answer Ethiopian IPs.

Options:

| Option | Description | Pros | Cons |
|---|---|---|---|
| **A** | Supabase EU (Frankfurt) as primary, plus an encrypted replica/backup on an Ethiopian cloud (Ethio Telecom Tele Cloud / Wingu / Raxio) | Fast to build, managed | May not satisfy a strict reading of Art. 22 |
| **B** | Self-hosted Supabase (or plain Postgres) on an Ethiopian cloud as primary; app servers in Ethiopia | Strongest compliance, lowest latency to shops | We run the database; more ops work |
| **C** | Hybrid: personal data (customers, Dube, payer names) in Ethiopia; non-personal data (catalog, images) global | Balanced | More complex |

**Plan:** build portable (Drizzle + plain Postgres features, no vendor lock-in), develop on Supabase cloud, and get **Ethiopian legal counsel** to answer Art. 22 before onboarding paying clients. The `apps/verifier` worker is hosted in Ethiopia either way.

### 2.4 Multi-tenancy model

- `tenants`, `branches`, `memberships(user_id, tenant_id, role_id, branch_scope)`; `tenant_id` on **every** business table, as the leading column of its indexes.
- RLS through a security-definer helper `private.my_tenant_ids()` in a non-exposed schema. Policies use `(select …)` wrapping. JWT claims are only a UI hint, **never** authorization.
- The owner login **bypasses RLS**, so the shop app does not use it: it logs in as the limited role `retail_app` (D26) and every tenant query goes through `db.rls(tx => …)`, which switches to role `authenticated` and sets the claims. `db.admin` (owner login) is importable only by `console`, cron jobs, `packages/db` and scripts (enforced by a lint rule).
- Vitest leak tests on a real Postgres prove that no table leaks across tenants, and a catalog-reading CI check proves every table is configured the same way (D27).
- IDs are UUIDv7, generated on the device, so offline sales are idempotent.
- **Full table design for Phase A:** [docs/DATA_MODEL.md](docs/DATA_MODEL.md) (approved, D20); Phase B in [docs/DATA_MODEL_B.md](docs/DATA_MODEL_B.md). It changes the RLS context: one active tenant per request, set by the server, which also covers PIN-only cashiers who have no auth account.

### 2.5 Shared core plus modules (the Planning Center model, modernised)

**Core (always on):** tenant/branches, staff and one login, **Customers** (phone-first), **Catalog**, the event/audit log, permissions, settings, **Alerts**, search (Ctrl+K).

| Module | Contents | Launch? |
|---|---|---|
| **POS** | Sale screen, payment tiles, receipts, shift open/close (Z report), returns/exchanges, order queue | MVP |
| **Inventory** | Stock ledger, receive, adjust, stock counts, lots/expiry, labels, suppliers | MVP |
| **Payments** | Verification pipeline, reference registry, self-pay links, review queue | MVP (lead) |
| **Dube / Credit** | Receivables plus payables, reminders, aging | MVP |
| **Promotions** | Discounts (strikethrough), featured items, negotiated pricing rules | MVP |
| **Expenses & Reports** | Expenses, profit, best sellers, dead stock, exports | MVP |
| **Serials** | IMEI/serial per unit, warranty lookup | MVP for electronics |
| **Announcements** | Tenant news and promos; platform → tenant notices | MVP (small) |
| **Storefront** | Public catalog site (Off / Private / Public) | Later |
| **Manufacturing** | Raw → production → finished (Neil Lewz Phase 3) | Later |
| **Multi-branch transfers** | | Later (paid tier) |

Each module has its own **accent color**, its own sub-menu with a **CONFIGURATION** group (Overview, …, Settings), and its own permission ladder (Viewer, Operator, Manager, Admin).

---

## 3. UI and UX system

Based on the Planning Center screenshots (Check-Ins Overview and Headcounts), modernised. The full pilot screen map and wireframes are in [docs/SCREENS.md](docs/SCREENS.md).

- **App shell:** collapsible left sidebar grouped by module, with a branch/shop switcher at the top. On phones this becomes a **bottom tab bar** (Home · Sell · Stock · Alerts · More).
- **Module identity:** a thin colored accent bar and icon per module, instead of Planning Center's heavy full-color header.
- **Right rail** (desktop) / header icons (mobile): 🔔 Alerts (red dot for fraud), ✅ Approvals, 💬 Messages.
- **Overview pages:** pastel **big-number tiles**, each with a trend line ("▲ 2 more than yesterday") and a sparkline, followed by **category cards with a colored header strip**, row items and a **Total** footer. 🔒 marks built-in items and ⚙ marks custom ones.
- **Lists:** saved views shown as tabs above tables ("Low stock", "Discounted"); filter chips; tables become cards on mobile; a side panel/sheet opens a record without leaving the list.
- **Ctrl+K command palette** across modules. An **activity timeline** on every record.
- **Low-literacy rules** (from research):
  - product photos and big icon tiles
  - one color per payment method, used everywhere
  - large numeric keypad for amounts
  - core sale ≤ 3 taps
  - deliberate confirm on sale (hold, or a big confirm screen), with a success screen, sound and haptics
  - 10-second undo
  - "Did you mean?" for duplicate sales
  - no modal error walls
  - an icon plus a short label on every action (English by default, Amharic one tap away; D22)
- **Theme:** light/dark per user; brand color per tenant; pre-paint script (no flash).

---

## 4. Settings (eecd-style, locked by default)

**Storage:** typed key/value `tenant_settings(tenant_id, group, key, value jsonb, type, is_public, updated_by, updated_at)`. Translatable values are `{en, am}`. Cache tag `settings:<tenant>`, cleared on save. A platform-side `setting_policies(tenant_id, key, state: editable|locked|hidden)` table, controlled from the console.

**Settings UI:** tabs in the URL, search box, Save per section, a 🔒 badge with "Contact support" on locked items, a PIN prompt on sensitive sections, and every change written to the audit log.

| Section | Contents | Launch state |
|---|---|---|
| Business profile | Name, logo, phone, address, opening hours, TIN | **Editable** |
| **Site content** (like eecd hero) | Hero title/subtitle/CTA, hero media (image/slider), overlay darkness, About, FAQ, contact, footer, social links, all en/am | **Editable** |
| Announcements | | **Editable** |
| Receipt | Footer text, show/hide fields, "not a fiscal receipt" label | **Editable** (fiscal label locked) |
| Inventory | Low-stock thresholds, expiry warning days | **Editable** |
| Language & calendar | Default language (English), calendar (Gregorian default, Ethiopian option) | **Editable** |
| My account | Own PIN, light/dark | **Editable** |
| Branding & theme | Presets + custom designer | 🔒 Locked (we pick a preset) |
| **Payment accounts** | Telebirr/CBE/bank numbers, QR | 🔒 **Locked permanently.** Changes need owner PIN **and** our approval, and raise an alert (classic payee-swap theft). |
| Modules & plan | | 🔒 Locked (console) |
| Storefront & SEO | Off / Private / Public | 🔒 Locked |
| Staff & roles | Role matrix | 🔒 Locked (default roles); adding staff is editable for owners |
| Pricing rules | Floor rules, discount max %, approval thresholds | 🔒 Locked |
| Alert rules | Built-in plus custom thresholds | 🔒 Locked |
| Security | Session length, which actions need PIN/approval | 🔒 Locked |
| Telegram | Linking, which alerts go to Telegram | 🔒 Locked (we link it at onboarding) |
| Data & backups | Export, backup status | Export: owner only. Backup config: hidden. |
| Billing & referrals | Plan, invoices, referral code and progress | View only |
| Danger zone | Delete data, close account | Hidden |

---

## 5. Roles, permissions and the master key

- **Permission keys** `resource:action` (e.g. `product:edit_price`, `discount:create`, `sale:below_floor`, `payment:verify`, `dube:write_off`), defined in `packages/core`.
- **Tables:** `roles(tenant_id, name, is_system)`, `role_permissions`, `memberships`.
- **Default roles:** Owner, Manager, Cashier, Stock clerk, Viewer.
- **One resolver** used everywhere (server actions, API, bot, UI gating). Permissions are re-read on every privileged action.
- **Rules (lessons from GraceAndGrind's holes):**
  - Never read roles from `user_metadata`.
  - You can only grant keys you hold.
  - You can't edit your own permissions.
  - The last Owner can't be removed.
  - Deny overrides really do remove a key.
  - Every role or permission change is audited.
- **Personal PINs** (not shared) for step-up actions: price change, discount, below-floor sale, void, refund, Dube write-off. The audit log records whose PIN was used.
- **Maker-checker** (from eecd): configurable actions such as a price change > X%, a discount > Y%, or a refund > Z become *requests*; the owner approves in the app or with one tap in Telegram.
- **Master key (break-glass)**, in `apps/console` only:
  - stored in a `platform_admins` table, separate from any tenant
  - requires 2FA plus a written reason
  - creates an `impersonation_sessions` row with expiry (default 1h) and **read-only by default**
  - write mode requires a second confirmation
  - the tenant UI shows a banner; the tenant owner is notified
  - every action is logged with `impersonator_id`
  - recovery actions: reset the owner's login or PIN, unlock an account, transfer ownership

> **Side note:** GraceAndGrind currently lets anyone sign up as OWNER (role read from signup metadata) and lets admins grant themselves any permission. Fix it separately if that app is live.

---

## 6. Data integrity: audit log, prices and alerts

### 6.1 Audit log (the iPhone dispute)
- A Postgres trigger on every business table writes to `audit.log`: tenant_id, actor, impersonator, PIN-used flag, device/IP, table, operation, before/after diff, txid and timestamp.
- **Hash chain per tenant:** `hash = sha256(prev_hash ‖ row)`. UPDATE/DELETE/TRUNCATE are revoked and blocked by a trigger. The nightly chain head is written to R2 with Object Lock, which makes the log tamper-evident.
- **Price history** per product. Each sale line stores `list_price`, `charged_price`, `price_source`, `discount_id`, `floor_at_sale` and seller.
- **Prevention:** a price change of more than 50% shows "200,000 → 20,000 (−90%)?" and asks for a PIN.
- **Retention: 10 years** for sales and invoice records (tax).

### 6.2 Pricing engine (`packages/core`, fully unit-tested)
Product fields: `list_price`, `floor_price` (hidden unless permitted), `wholesale_price`/quantity tiers, and active `discount` (percent or fixed, start/end, `feature_in_hero`, `create_announcement`).

| Sale situation | Result |
|---|---|
| List price, valid tier price, or active discount price | ✅ |
| Negotiated between floor and list price | ✅ recorded as `negotiated` |
| Below floor | ⛔ manager PIN required, then 🟠 Suspicion |
| Discount active but charged full price | 🟠 Suspicion (possible skimming) |
| Above list price | 🟠 Suspicion |

Strikethrough "was" prices are shown only if that price genuinely applied (consumer law). The price history is the proof.

### 6.3 Alerts center

| Category | Color | Examples |
|---|---|---|
| Fraud | Magenta | Duplicate reference (same shop or platform), reused screenshot (perceptual hash), bank lookup mismatch, price changed right before the same user sold the item |
| Suspicion | Orange | OCR amount mismatch, below-floor sale, discount not applied, after-hours sale, void after scan, cash short at shift close |
| Errors | Red | Sync failed, backup failed, bank lookup unreachable, Telegram down |
| Alerts | Amber | Low stock, expiry soon, Dube overdue, discount ending |
| Messages | Violet | Staff and customer messages, approval requests |
| Info | Blue | New order, restock, verified payment |

- Table: `alerts(tenant_id, category, rule_key, severity, entity_type, entity_id, payload, status: new|ack|resolved|dismissed, assignee, resolution_note)`.
- The UI follows §3: number tiles with trend, then category cards, then a side panel with evidence (receipt, OCR text, bank result, audit trail) and **Verified / Fake / Dismiss**.
- Fraud and Suspicion alerts are also pushed to Telegram.

---

## 7. Feature specs

### 7.1 Payment verification pipeline (headline feature)

1. **Capture:** decode the receipt QR code or link first, then OCR (tesseract.js with a whitelist and per-provider regex), then manual entry (flagged `manual`). A reference is **required** for every digital payment.
2. **Format checks:** provider regex (CBE `FT\d{5}[A-Z0-9]{5}`, Telebirr 10 alphanumeric, …). The CBE date code must be within ±1 day; amount ≥ due. Apply OCR confusion fixes (O/0, I/1, S/5, B/8).
3. **Duplicate checks:**
   - **Same shop:** full preview (who paid, amount, when, which cashier, link to the earlier order).
   - **Other shops:** only "used before on [date]". Stored as an HMAC-peppered hash with no shop, payer or amount (data protection law), and kept 12–24 months.
   - The image's perceptual hash plus SHA-256 catches reused screenshots.
4. **Official lookup** by `apps/verifier` (Telebirr needs it hosted in Ethiopia, so Telebirr lookup waits for the migration, D24):
   - fetches the bank's own receipt page (CBE legacy and new, Telebirr, BOA, Dashen, Awash, M-Pesa…)
   - requires status = completed, the receiver matching the shop's registered account, amount ≥ due, and the date within the window
   - results are cached forever; 30 lookups/min per tenant
   - if the bank is unreachable, the payment goes to `pending_verification`, not failure
   - ⚖️ needs a legal review before we market it as "official verification"
5. **Result:** 🟢 auto-verified, 🟡 needs a staff check (copy reference → check the shop's SMS or app), 🔴 blocked or fraud.
6. **Optional gateway per shop** (Chapa or Telebirr merchant, using the shop's own credentials, idempotent webhooks): skips steps 1–5. ⚠️ Ethiopian gateways had accounts frozen in Dec 2025, so this is never a core dependency.

**Stages shown to customer and staff (stepper):**
- **Cash:** Received → ✅ Done
- **Digital:** ① Submitted → ② Auto-check (✔/✖/⚠ rows: reference found, amount, method, never used before, image unique, bank confirmed) → ③ Staff verified (if needed) → ✅ Confirmed / ❌ Rejected / ⚠️ Fake
- **Dube:** Recorded → Partially paid → ✅ Settled

**Customer pay page (mobile):**
- large amount
- tap-to-copy account number and amount
- QR code
- "Open Telebirr" where possible
- camera upload with live check rows
- a stepper that updates live
- optional Telegram notification when confirmed

**Staff review (mobile):**
- swipeable queue of cards
- receipt image next to an expected vs read vs bank comparison
- 📋 copy reference
- Verified / Fake / Reject with reason
- the same buttons in Telegram

### 7.2 Self-pay link with discount (customer pays on their own phone)

- The cashier shows a QR code containing a **one-time signed link** (HMAC; order, amount, shop; 15–30 min expiry). The customer pays in Telebirr/CBE and uploads the screenshot themselves.
- The **discount (e.g. 3%) is applied only after the payment is verified** (bank lookup or staff), never on upload.
- **Anti-abuse:**
  - IP addresses are useless on Ethio Telecom (shared IPs, CGNAT), so use them only for rate limits.
  - Identify by **phone number plus device ID** (a UUID stored on the phone) plus a **light fingerprint** (ThumbmarkJS or FingerprintJS v5, both MIT). The fingerprint is a soft signal only.
  - Perceptual image hash.
  - A cap on discounted orders per phone/device per day and on the discount amount per order.
  - The payer name on the receipt should stay consistent for a phone number.
  - Velocity flags (one device using many phone numbers).

### 7.3 Dube / credit (both directions)
- **Receivables** (customers owe the shop) and **payables** (shop owes a supplier).
- Fields: party name and phone, items or amount, date, optional due date, optional reminder date, method (cash/Telebirr/CBE plus reference), status (open/partial/paid/overdue/written-off), partial repayments, notes, photo of signed paper.
- "Dube" is a payment tile at the POS. Aging report (0–30 / 31–60 / 60+ days).
- Reminders go to the owner via Telegram. Messages to customers are opt-in (consent).
- ⚖️ **Record-keeping only:** no interest, no lending, no platform funding.

### 7.4 POS essentials (missed in the first draft)
- **Shift open/close (Z report)**: opening float; expected vs counted, **per payment method**; denomination calculator; difference becomes an alert; closing cash carries forward.
- **Returns/exchanges**: restock or write off, refund method, store credit.
- **Voids** only with a reason, and audited.
- **Wholesale/retail price tiers**, **variants** (storage/color/shade), **decimal quantities** (kg).
- **Receipts:** digital (Telegram/link) plus optional Bluetooth 58mm printing; TIN/VAT/TOT fields ready for e-invoicing; "not a fiscal receipt" until certified.

### 7.5 Electronics: IMEI/serial
- Per-unit serial captured at receive and at sale; full history lookup (who sold it, when, at what price); warranty period with a lookup by serial.
- Prevents swapped returns.
- Trade-ins come later.

### 7.6 Inventory
- Append-only stock ledger (FEFO, ported from Neil Lewz), receive with cost, adjust with reason, **stock counts**, lots/expiry (optional per product), labels (Code 128 + QR), suppliers.
- Offline sales never conflict; they can only produce negative-stock alerts.

### 7.7 Images and editor
- Editor: react-easy-crop (crop with 1:1 default, zoom, rotate), brightness/contrast/saturation via canvas, EXIF orientation fix.
- Output: **WebP, 1200px, about q0.75 (~80–120 KB)** plus a **400px thumbnail (~15 KB)**, produced by browser-image-compression in a Web Worker.
- **Up to 5 images per product:** 1 required (main) plus 4 optional, labelled front/back/side/detail/box. The plan can lower the limit.
- R2 via presigned PUT; a custom loader (no paid image transforms).
- About 165 MB per 300-item shop at 5 images per item.

### 7.8 Onboarding mini-app (field work)
- Phone-first, works offline.
- **Industry templates** with fields per vertical.
- **Loop:** scan barcode → match in **Master Catalog** → photo and edit → price/floor/tier → next.
- Also: CSV import, a progress counter ("212/300"), and logging of who entered what.
- **Redundancy without dual-writing:** items are saved on the device first, then on the server. Each finished batch is immediately exported to R2 (and Drive if legal). Items feed the Master Catalog, so they are never re-entered.

### 7.9 Master Catalog
- `master_products` per industry (name en/am, brand, model, barcode, images, attributes). The tenant product links to a master product plus its own price and stock.
- New tenant items are reviewed by us before they are promoted to master.

### 7.10 Telegram bot v2
- One platform bot (`apps/bot`, grammY).
- Shop linking via a deep link `t.me/<bot>?start=<one-time-code>` (hashed, 10-minute TTL). `/switch` for multi-shop users.
- Telegram users map to memberships, so **RBAC applies in Telegram too**.
- **Professional templates** (HTML mode):
  - consistent header with the shop name
  - `<code>` references (tap to copy)
  - masked phone numbers
  - no Dube details in group chats (privacy)
- Features:
  - alerts with **Verified / Fake / Open** buttons
  - approval requests (price/discount/refund)
  - daily close summary
  - low stock and expiry
  - Dube reminders
  - `/sales today`, `/stock <item>`, `/dube`, `/pending`
- State lives in Postgres (no in-memory sessions). Slow work is queued so the webhook answers quickly.

### 7.11 Announcements
- Types: news, update, discount, featured, new arrival.
- Fields: linked products, CTA link, image, placement (banner / hero / News page / Telegram channel), schedule.
- An "also create announcement" checkbox when featuring or discounting an item.
- Platform announcements (from us to all tenants: releases, outages).

### 7.12 Referrals
- Front-loaded tiers (D9), recalculated monthly. **Only actively paying referred shops count.** Each counts after **2 paid months** and N real sales.
- **Two-sided one-time reward:** the new shop gets its first month half price; the referrer gets one free month when the referee pays month 2.
- Reward is **always subscription credit, never cash**. **Single level only** (Ethiopian anti-pyramid law, Proclamation 813/2013).
- Anti-abuse: one reward per TIN/license/phone; flag shared device/payer numbers; manual review above 5 referrals.
- In-app referral page: code and link, each referral's status, current %, progress to next tier.

### 7.13 Storefront and SEO (later)
- Off / Private (link only, `noindex`) / Public (sitemap, OG, canonical done properly).
- Subdomain per shop; custom domains via Cloudflare for SaaS (100 included).
- The **Telegram catalog link** is the default "online presence" for small shops.

### 7.14 Backups
- Supabase daily backups (Pro) plus **nightly `pg_dump` from GitHub Actions**, encrypted (`age`), to R2 with versioning and Object Lock, plus a copy in Ethiopia (§2.3).
- Google Workspace **Shared Drive** copy only after the legal review (service accounts need a Shared Drive and `supportsAllDrives`).
- Per-tenant export (zip of JSON/CSV plus images) as a queue job; owners can download it.
- Restore drill every quarter. Backup status shows in the console.

### 7.15 Offline app
- PWA: Serwist precaches the POS shell; PowerSync syncs catalog, prices and customers down, and sales, Dube and stock moves up via a **versioned `/api/sync/v1`** (not Server Actions, which break across deploys).
- Offline behavior: cash sales work fully; digital payments become `pending_verification`; new device IDs per sale.
- PIN actions offline (below-floor, void, refund, discount): no PIN check on the device. The action is saved as `pending_approval` with a Suspicion alert and settled after sync (D18).
- Later: Capacitor Android app (native SQLite, Bluetooth printers, Play Store).

### 7.16 SaaS console (`apps/console`)
- Tenants (plan, modules, setting policies, usage), subscriptions and invoices, **pending payments**, pause access when unpaid (never delete), referrals ledger, backup status, alert overview across tenants, break-glass, Master Catalog review, platform announcements.
- **Versions:** semver releases, changelog, "What's new" in tenant apps, optional beta group, mobile app version tracking.

---

## 8. Compliance checklist (needs an Ethiopian lawyer before paid launch)

1. ⚖️ **Hosting and Art. 22 data localisation** (§2.3).
2. Register with the **Ethiopian Communications Authority** as a processor (and controller for the fraud registry); help shops register.
3. **DPA** with shops (processor role, sub-processors, 72h breach notice, export/delete, fraud-registry clause). Privacy notice in en/am, plus a notice shops can display to customers.
4. Fraud registry: hashed references, "used before" answer only, limited retention, legitimate-interest assessment on file.
5. Data subject rights: access, export, correct, delete (with tax-retention exception).
6. Breach runbook (72h to ECA and affected people).
7. **E-invoicing Directive 1142** (covers SaaS sales-register providers): contact the Ministry of Revenues about the phase schedule and licensing. Receipts are "not a fiscal receipt" until certified; data model ready (TIN, VAT 15%, TOT, sequential invoice numbers, 10-year retention).
8. Payments: verification only; never hold funds (avoids an NBE licence); gateways only with direct settlement to the shop.
9. Dube: records only; no interest or lending.
10. Pricing: tax-inclusive display; truthful strikethrough prices (price history as proof).
11. Referrals: single level, credit only.
12. Automated bank receipt lookup: legal opinion (Computer Crime Proclamation 958/2016, bank terms).
13. Company: Ethiopian PLC, trade licence, TIN, VAT if over ETB 2M.

---

## 9. Phases

| Phase | Scope | Exit criteria |
|---|---|---|
| **0: Decisions** | Name, pricing tiers, lawyer on §2.3/§8, collect 20+ real CBE/Telebirr receipt samples | Legal green light on fraud registry and lookup; deadline for the Ethiopian migration known |
| **A: Foundation** | Monorepo, Drizzle schema and migrations, tenancy and RLS with leak tests, auth, RBAC, PINs, audit log with hash chain, settings framework and policies, app shell (sidebar/bottom bar, Ctrl+K), i18n (English default) and calendar (Gregorian default, Ethiopian option), UUIDv7 IDs | A Cashier in tenant A cannot see tenant B (tests); audit chain verifies |
| **B: Sell & stock** | Catalog (variants, tiers, decimal quantity), images and editor, POS (sale, payment tiles, receipts, returns, voids, shift close/Z), inventory ledger, stock counts, labels, scanner | Neil Lewz flows reproduced on new stack |
| **C: Money integrity** | Pricing engine (floor, discounts, negotiation), maker-checker, alerts center, payment pipeline (OCR, references, hashes, review stepper), `apps/verifier` (CBE, Telebirr, BOA first), self-pay link | Fake/duplicate receipt caught in tests and in pilot |
| **Pilot cut (D11)** | A + B + from C: reference registry (unique per tenant), same-shop duplicate preview, image SHA-256 + perceptual hash, manual review queue, floor-price PIN, basic Telegram alerts. **Not in the pilot:** bank lookup, self-pay links, Dube, console (tenants created by hand), Master Catalog promotion, offline | 2–3 electronics shops run their daily sales on it for 2 weeks; zero cross-tenant leaks |
| **D: Merchant value** | Dube (both directions), expenses and profit reports, exports, Telegram bot v2, announcements, IMEI/serial plus warranty | Pilot shop runs a full week on it |
| **E: Onboarding & platform** | Onboarding mini-app, Master Catalog, console (tenants, billing, pending payments, referrals, versions, break-glass), backups and restore drill | Second electronics shop onboarded in under a day |
| **F: Offline** | PWA with PowerSync and outbox; then Capacitor Android | Sell for 1 hour offline, sync clean |
| **G: Later** | Storefront and SEO modes, theme designer, multi-branch transfers, trade-ins, loyalty, SMS, e-invoice integration, manufacturing module, Neil Lewz migration as tenant #1 | |

> **Phase A task-by-task plan:** [docs/PHASE_A_PLAN.md](docs/PHASE_A_PLAN.md) (about 6–7 weeks; first pilot shop about 3.5–4.5 months after "start Phase A").

> Offline is "non-negotiable before launch" per *SaaS Oportunity.md*. Phases A–C are built offline-ready (device IDs, versioned sync API, ledger stock), so F stays cheap. Phase F must finish before **paid** launch.

---

## 10. Open questions

Resolved on 2026-10-16: domain (D19), pricing (D12), hosting approach (D13, D24; quotes deferred), field onboarding (D15), Neil Lewz manufacturing (D16), self-pay discount (D17).

1. Product name (doesn't block Phase A).
2. **Partnership and legal entity:** is this a Grace & Grind product or a separate venture with Nate? This decides who owns the PLC, who signs the DPA with shops, and who engages the lawyer. Needed before the pilot.
3. **Later, not now:** when must we move to Ethiopian servers (lawyer, Art. 22), and to which provider (D24).
4. Lawyer engagement: brief ready in [docs/LAWYER_BRIEF.md](docs/LAWYER_BRIEF.md).
