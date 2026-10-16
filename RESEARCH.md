# Research Digest (2026-10-16)

This summarizes the research behind [PLAN.md](PLAN.md). Items marked **[unverified]** come from a single or secondary source. This document is **not legal advice**: an Ethiopian lawyer must confirm the legal sections.

---

## 1. Ethiopian payment verification

### 1.1 Bank receipt endpoints
These are not public APIs. They are the receipt links the banks themselves send in SMS messages and show in their apps.

| Provider | Endpoint pattern | Extra input | Returns / notes |
|---|---|---|---|
| CBE (legacy) | `https://apps.cbe.com.et:100/?id={FT_REF}{LAST_8_DIGITS}` | Last 8 digits of the account. Sources conflict on payer vs receiver **[test]** | PDF: payer, receiver, amount, date, reference. The host is often unreachable. |
| CBE (new mobile) | `https://mb.cbe.com.et/api/v1/transactions/public/transaction-detail/{RECEIPT_ID}` (via `mbreciept.cbe.com.et/{id}`) | Receipt token, not the FT number. Needs app headers. | JSON. The app headers are a grey area. |
| Telebirr | `https://transactioninfo.ethiotelecom.et/receipt/{TXN_NO}` | None | HTML: payer, credited party, status, amount, fees. **Answers Ethiopian IPs only.** |
| Bank of Abyssinia | `https://cs.bankofabyssinia.com/api/onlineSlip/getDetails/?id={REF}{LAST5}` | Last 5 digits | JSON. Check the status field. |
| Dashen | `https://receipts.dashenbanksc.com/receipt/{FT_REF}` | None | HTML. Returns 400 for an unknown reference. |
| Awash | `https://awashpay.awashbank.com:8225/-{ref}` | None | HTML **[unverified]** |
| M-Pesa ET | `https://m-pesabusiness.safaricom.et/api/receipt/getReceipt?trxNo={REF}` | None | base64 PDF, geo-blocked, beta |
| CBE Birr | Not published | Reference plus payer phone | In development elsewhere |

**Reference implementations (MIT, read them for reference rather than depending on them):**
- https://github.com/1RB/cheki: widest bank coverage and a unified schema.
- https://github.com/Zahir-Seid/cbe-verifier: Go, v2 released Aug 2026, handles both CBE receipt formats.
- https://github.com/Vixen878/verifier-api: TypeScript.
- https://github.com/abrhamyalew/unified-receipt-verifier

**Commercial competitors:** verify.et, ShegerPay, Tina Verify.

### 1.2 Reference formats
- **CBE:** `FT` + 2-digit year + 3-digit day-of-year + 5 alphanumerics, e.g. `FT25292FRPWD`. Regex: `\bFT\d{5}[A-Z0-9]{5}\b`. With the account suffix it is 20 characters long. **[the date encoding is inferred]**
- **Telebirr:** 10 uppercase alphanumerics, e.g. `CJP9OSP9WZ`. Require at least one letter and one digit. The prefix is not confirmed.
- **Dashen:** 16-character FT reference. **BOA:** reference plus a 5-digit suffix.
- **OCR fixes:** O↔0, I↔1, S↔5, B↔8, then re-validate. Prefer reading the receipt's QR code or link over OCR.
- **TODO:** collect 20 or more real receipts per provider to confirm the regex patterns.

### 1.3 Gateways
- **Dec 29, 2025:** the Ministry of Justice ordered banks to freeze accounts linked to about 10 gateway operators (Chapa, ArifPay, SantimPay, AddisPay, Kacha…). In May 2026 Chapa, ArifPay and SantimPay appealed to the National Bank; I found no reported resolution. https://ethiopianbusinessreview.net/ethiopias-top-three-payment-gateways-appeal-to-national-bank-over-tax-enforcement-actions-citing-legal-violations/
- **Chapa:** supports subaccounts and split payments; KYC needs a TIN and license. https://developer.chapa.co/docs/split-payment/
- **Telebirr direct (H5/C2B):** per-merchant onboarding at developer.ethiotelecom.et. I found no aggregator model.
- **Conclusion:** offer gateways as an optional add-on per shop, using the shop's own credentials. Never make one the core flow.

### 1.4 Fraud patterns
- Fake-Telebirr apps ("Loki"), fake confirmation Telegram bots, reused old receipts, edited amounts or names, "pending" shown as paid, AI-edited receipts.
- Sources:
  - https://verify.et/blog/fake-payment-screenshot-ethiopia-merchant-guide
  - https://verify.et/blog/stop-fake-telebirr-payments-loki-app-verify-et
  - https://addissphere.com/2026/09/04/securing-mobile-money-in-ethiopia/
  - https://shega.co/news/issue-95-rising-mobile-banking-scams-capital-injections

### 1.5 Device identity
- **CGNAT** on Ethio Telecom means many users share one IP, so IP addresses are only useful for rate limiting.
- **FingerprintJS v5** was relicensed to MIT in October 2025. **ThumbmarkJS** is MIT. Open-source fingerprinting is roughly 40–80% accurate, so treat it as a soft signal only.
  - https://fingerprint.com/blog/fingerprintjs-version-5-0-mit-license/
  - https://github.com/thumbmarkjs/thumbmarkjs

---

## 2. Legal and regulatory

| Topic | Finding | Source |
|---|---|---|
| Data protection | Proclamation **1321/2024**, in force since 24 Jul 2024. Regulator: Ethiopian Communications Authority. Legal bases include legitimate interest (Art 7). Controllers and processors must register (Arts 33–39). **Art 22: storage on a server in Ethiopia.** Breach notification within 72h. Fines up to 4% of turnover, plus criminal penalties (Art 64). Enforcement has been slow; the ECA registration portal opened around Nov 2025. | https://www.metaappz.com/References/ethiopian_laws/federal/pr_1321_2024/en/txt · https://shega.co/news/one-year-on-ethiopia-s-personal-data-protection-law-faces-a-slow-path-to-enforcement · https://dti.eui.eu/database/page/191 |
| Cross-shop reference sharing | No explicit fraud-prevention exemption. Legitimate interest is plausible if we store only a hash, answer only "used before", limit retention, and disclose it in the DPA. *(analysis)* | — |
| E-invoicing | **Directive 1142** (about mid-2026) explicitly covers **SaaS sales-register providers**. Requires connection to the central system, an IRN and a QR code. Phased schedule; licences renewed every 2 years; possible provider guarantees of USD 15–50k **[unverified]**. | https://lookuptax.com/tax-changes/ethiopia/electronic-invoicing-directive-1142-2026 · https://www.e-invoice.app/guides/ethiopia-e-invoicing · https://regfollower.com/ethiopia-introduces-electronic-invoicing-directive/ |
| VAT | Proclamation 1341/2024. Registration threshold ETB 2M. Standard rate 15%. | https://www.ey.com/en_gl/technical/tax-alerts/ethiopia-introduces-new-vat-proclamation-introducing-raft-of-changes |
| Income tax | Amendment 1395/2025 removes Category C and adds a 2.5% alternative minimum tax. Gazettement status is disputed. | https://taxsummaries.pwc.com/ethiopia/individual/significant-developments |
| National Bank | Payment Proclamation 718/2011, amended by 1282/2023. Verifying payments only, without holding funds, means we are not a payment service provider *(analysis)*. | https://dmethiolawyers.com/ethiopias-payment-system-regulation-shaping-the-future-of-payment-transactions/ |
| Consumer protection | Proclamation 813/2013 prohibits false price-reduction claims and requires tax-inclusive prices and receipts. | https://ethiopianbusinessreview.net/consumer-protection-overview-of-the-legal-framework/ |
| Pyramid / MLM | Rewarding the recruitment of recruiters is banned under 813/2013; TIENS was banned. **Referrals must be single-level and paid as credit.** | https://capitalethiopia.com/2023/05/02/we-are-not-a-pyramid-scheme-business-etcare-declares/ |
| E-transactions | Proclamations 1205/2020 and 1072/2018 (e-signature). E-records are generally valid; tax e-invoice rules take precedence. | https://dmethiolawyers.com/electronic-signature-in-ethiopia/ |
| Hosting in Ethiopia | Ethio Telecom Tele Cloud, Wingu.Africa, Raxio, Redfox (ICT Park). | https://shega.co/news/ethio-telecom-enters-cloud-computing-business-with-tele-cloud |

---

## 3. Competitors and features

### Local competitors
- **Bileh Tracker** (bileh.com) has Android, Windows and web apps, Amharic/English, works offline, Ethiopian calendar, Dube, screenshot proof, PINs and roles, Z report, multi-branch. Pricing: **free (20 products / 100 transactions), 400 ETB/mo Pro, 600 ETB/mo Premium**, sold through a Telegram bot.
  - https://www.bileh.com/en
  - https://play.google.com/store/apps/details?id=com.bileh.tracker
- **Vega POS** (Kenya) integrates Telebirr, Chapa and ArifPay. ETB 1,200–8,500/mo. https://vega.co.ke/blog/pos-system-in-ethiopia/
- Not confirmed as live products: epos.et, Sawa, Mirach, Qene.

### Lessons from emerging markets
- **Credit ledger plus reminders drives adoption.** Khatabook has 50M+ downloads and OkCredit 10M+.
- **Free bookkeeping without revenue fails.** Kippa raised $14M, shut down, and users lost their data. Lessons: charge early, always allow export. https://techcabal.com/2024/02/23/kippa-users-left-in-the-dark/
- **Storefronts for tiny merchants mostly failed** (Khatabook MyStore, Dukaan). https://the-ken.com/story/why-khatabook-okcredits-kiranatech-failed-to-fly-off-the-shelves/
- **Daily till reconciliation** across POS records, mobile-money statements and counted cash (Kenya). https://paybillke.com/guides/mpesa-daily-till-reconciliation-2026

### Global POS complaints (Loyverse, Square)
- Discounts only apply to the whole ticket.
- Weak variant support.
- **Open tickets can be deleted without a trail.**
- No denomination calculator at cash close.

These are solved in the plan by line-level discounts, the audit log, voids that require a reason, and the Z report with a denomination calculator.

### Verdicts
| MVP | Later | Leave out |
|---|---|---|
| POS, payment tiles, fraud pipeline, Dube (both directions), Telegram reminders, Z report, voids with reason, returns, line discounts plus floor, wholesale tiers, variants, IMEI plus warranty, lots/expiry, decimal quantities, suppliers and receiving, stock counts, expenses, profit reports, Ethiopian calendar, Amharic, Bluetooth printing (optional), receipt fields ready for VAT, offline, Master Catalog, alerts, PINs and roles, platform announcements, simple referrals, console, export | SMS, trade-ins, formal purchase orders, multi-branch transfers, loyalty, bundles, storefront, e-invoice integration, theme designer | Repair tickets, time clock, lending/BNPL |

### Low-literacy UX
- Graphical interfaces beat text-only ones for first-time users (Microsoft Research). Use a numeric keypad, a deliberate confirm step on sales, and a core flow of 3 taps or fewer.
  - https://www.microsoft.com/en-us/research/project/uis-low-literate-users/

---

## 4. Technical

### Cloudflare and Next.js
- **Cloudflare now recommends "vinext" (beta) over OpenNext for new apps.** https://developers.cloudflare.com/workers/framework-guides/web-apps/opennext/ Keep the code portable.
- **`proxy.ts` runs on Node only.** OpenNext support for it is experimental, and it breaks when `@opentelemetry/api` is installed (pulled in by Sentry). https://github.com/opennextjs/opennextjs-cloudflare/issues/1400 Keep proxy limited to host parsing and rewrites.
- **Next 16 caching:**
  - `'use cache'` blocks cannot read cookies or headers; pass `tenantId` as an argument.
  - Calling `revalidateTag(tag)` with one argument is deprecated. Use `revalidateTag(tag, 'max')` or `updateTag()`.
- **Server Action IDs change with every build**, so an offline POS must sync through a versioned API rather than Server Actions.
- **Worker limits:** 30s CPU (configurable up to 5 min), 128 MB memory, 1s startup. Check the bundle size limit on the live limits page. https://developers.cloudflare.com/workers/platform/limits/
- **Smart Placement:** use it to run Workers near the database. Otherwise every query from Addis makes an EU round trip.

### Database (Supabase and Drizzle)
- **RLS:** use a membership table with a security-definer helper, wrap calls in `(select …)`, and lead every index with `tenant_id`. https://supabase.com/docs/guides/database/postgres/row-level-security
- **Drizzle connects as the database owner, which bypasses RLS.** Every query must go through the `set local role authenticated` plus claims transaction wrapper. https://orm.drizzle.team/docs/rls
- **Hyperdrive:** use the Supabase direct connection string and disable caching for role-switched transactions.

### Offline
- **PowerSync** is Supabase-native and includes a Capacitor SDK. Pricing: free tier (dev only, deactivates after a week of inactivity), Pro from $49/mo, or a self-hosted Open Edition. https://www.powersync.com/pricing
- **Serwist** with Turbopack: use `@serwist/turbopack`, not `@serwist/next`. https://serwist.pages.dev/docs/next/turbo
- **`useOffline`** in Next 16 keeps its queue in memory only, so it cannot serve as the outbox.

### Audit log
- Custom trigger with a hash chain per tenant, using `pg_advisory_xact_lock` per tenant.
- Revoke UPDATE, DELETE and TRUNCATE, and add a blocking trigger.
- Anchor the chain head nightly to R2 with Object Lock.
- supa_audit has no actor or hash; pgaudit is the wrong tool for this.

### Backups
- Supabase Pro keeps 7 days of daily backups. Point-in-time recovery is a $100/mo add-on.
- `pg_dump` cannot run on Workers, so run it from GitHub Actions, encrypt with `age`, and store in R2.
- A Google Drive service account needs a **Shared Drive** and `supportsAllDrives=true`.

### Telegram
- grammY with `webhookCallback(bot, "cloudflare-mod")`, `botInfo` precomputed, and a webhook `secret_token`.
- Deep-link payloads are limited to 64 characters from `[A-Za-z0-9_-]`.
- Use HTML parse mode; text in `<code>` is tap-to-copy. Message limit is 4096 characters.
- Rate limits: about 1 message/s per chat, 20/min per group, 30/s globally.

### Images
- react-easy-crop for cropping.
- browser-image-compression (runs in a Web Worker): WebP at about q0.75, 1200px plus a 400px thumbnail.
- `createImageBitmap(file, {imageOrientation:'from-image'})` to handle orientation.
- Skip AVIF encoding; it is too slow on low-end Android phones.

### OCR
- tesseract.js 7 is 15–35% faster than v6 and works well on clean screenshots when combined with a character whitelist and regex checks.
- Fallback: Workers AI vision models (llama-4-scout, mistral-small-3.1, moondream) at roughly ≤ $0.001 per image.

### Theme
- culori (OKLCH color scales), react-colorful (picker, ~2.8 KB).
- Use a WCAG 4.5:1 contrast check as a hard gate; APCA as advisory only.

### Testing
- Vitest and Playwright (`devices['Pixel 7']`, `setOffline`).
- pgTAP cross-tenant leak tests on every table.
- Sentry on the client only for now: the server SDK has OpenNext issues. https://github.com/getsentry/sentry-javascript/issues/22794
- PostHog for analytics.

---

## 5. Internal references reviewed

### Neil Lewz (`Desktop/Projects/Neil Lewz`)
- **Reusable logic:** receiptParser, OCR flow, FEFO stock procedures, scanner hooks, labels, kiosk PIN sessions, LiveRefresh.
- **Issues not to repeat:**
  - Schema drift (`schema.sql` is missing `employees`, `stock_batches` and other columns).
  - Online checkout trusts client-sent prices.
  - The duplicate-reference check runs only at POS, and there is no unique index.
  - Price changes are not logged.
  - Telegram sessions are kept in memory.
  - About 25 files hardcode the brand name.
  - The canonical URL is set to "/" on every page.

### eecd-church (Laravel)
- **Borrow:**
  - Typed key/value settings table with cache plus flush.
  - The settings tab layout, including hero, theme, features and member toggles.
  - Maker-checker (`pending_changes`).
  - `activity_logs` audit trait.
  - Lookup tables.
  - Notification templates and logs.
  - Translatable JSON columns.
- **Don't copy:**
  - Settings written into language files.
  - Theme colors taken from env vars.
  - Hardcoded role checks.
  - The feature-flag and module-registry interfaces, which were never implemented.

### GraceAndGrind (Next 16, Prisma)
- **Borrow:**
  - `resource:action` permission keys.
  - Role, Permission and RolePermission tables.
  - Grouped role editor.
  - Re-reading permissions from the database on each request.
- **Don't copy (security holes):**
  - The role is read from signup metadata, so **anyone can become OWNER**.
  - Users can edit their own permissions.
  - Custom roles bypass the hierarchy.
  - Deny entries are ignored.
  - Four separate permission resolvers.
  - RLS is effectively off.
  - The audit log can be erased.

### Planning Center
- **Model:** separate products sharing one People database, one login, an app switcher, a permission ladder per app, an Organization Admin above all apps, and per-product billing with People free.
- **UX:**
  - A colored band per module.
  - A sub-menu with a CONFIGURATION group.
  - Big pastel number tiles with trend lines.
  - Category cards with colored header strips and totals.
  - A right-hand icon rail.
- **Criticism:** dated look, inconsistent design across apps, no cross-app search.
- Sources:
  - https://www.planningcenter.com/
  - https://help.planningcenter.com/en/permissions-in-services.html
  - https://help.planningcenter.com/en/136790-planning-center-pricing.html
