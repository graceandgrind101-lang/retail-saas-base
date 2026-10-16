# Conversation Context (planning session, 2026-10-16)

This is a handoff summary of the planning conversation held in the Neil Lewz workspace. It records what the owner asked for, in their own words where possible, and what was decided and why. Use it together with [../PLAN.md](../PLAN.md).

---

## 1. Starting point
- **Neil Lewz:** a single-tenant Next.js 16 + Supabase e-commerce and POS app for a peanut-butter business in Addis Ababa. It includes:
  - kiosk POS with PIN login
  - OCR on CBE/Telebirr receipts
  - Telegram bot
  - stock ledger
  - labels
  - en/am languages
  - Cloudflare Workers hosting

  Its full handoff is in `Neil Lewz/LOG.md`.
- **`SaaS-Oportunity.md`** (copied to `docs/reference/`): the business case for turning it into a multi-tenant SaaS. Launch verticals are electronics and mini-markets; it also introduces the Master Catalog idea and the pricing tiers.
- **The owner wants:**
  - Planning Center-style modularity (separate modules connected through a shared core)
  - a clean, easy-to-read feel, but more modern than Planning Center

## 2. The owner's original 19 requests → where they live in PLAN.md
| # | Request (summarised) | PLAN.md |
|---|---|---|
| 1 | Robust settings like eecd. Theme presets plus Photoshop-style color pickers and sliders. | §4 (theme designer locked for now, moved to phase G) |
| 2 | RBAC like GraceAndGrind, plus a **super-admin master key** to help a locked-out tenant admin | §5 |
| 3 | Referral discount: 5×5%, 5×3.5%, 5×1.5%, capped at 50%. Owner asked whether to reverse the order. | §7.12 (kept front-loaded) |
| 4 | Discount pricing shown Amazon-style. Changing discounts needs a PIN. Discounted items optionally featured in the hero or announced. Flag a discounted item sold without its discount. | §6.2, §7.11 |
| 5 | Ethiopian price negotiation: floor and ceiling. No flag inside the range. | §6.2 (D4: below floor = manager PIN + flag) |
| 6 | Logs to settle disputes like "I set the iPhone at 200,000, not 20,000" | §6.1 |
| 7 | Manual onboarding of products. Tiny but good-quality images. Telegram/WhatsApp-style crop, rotate and color editor. | §7.7, §7.8 |
| 8 | Regular backups, e.g. to the owner's Google Workspace | §7.14 (Drive only after legal review) |
| 9 | Don't lose a 300-item entry session. Owner asked for a write to 2 DBs; we chose device-first saving plus batch export plus the Master Catalog instead. Wants a fast onboarding mini-app per industry. | §7.8, §7.9 |
| 10 | Dube/loan register: name, date, optional deadline, optional reminder, cash/Telebirr, status | §7.3 (both directions) |
| 11 | App versions and version control in a dedicated SaaS management web app: clients, payments, pending payments | §7.16 |
| 12 | SEO/public site off by default, toggled in settings | §7.13 (Off / Private / Public) |
| 13 | Offline app for internet or power outages | §7.15 |
| 14 | Adopt the SaaS advantages from eecd | §4, §5 (maker-checker), RESEARCH §5 |
| 15 | Color-coded dashboard for Alerts, Messages, Errors, Suspicion and Fraud, styled like the Planning Center screenshots | §3, §6.3 |
| 16 | Save reference numbers; copy-paste ready for checking in the Telebirr/CBE apps, in Telegram and in the backend | §7.1, §7.10 |
| 17 | Rework the Telegram bot to look professional; it's a selling point | §7.10 |
| 18 | Announcement pages for news, updates and discounts; optional announcement when an item is featured or discounted | §7.11 |
| 19 | 3–5 images per product (front, back, side…) with size in mind | §7.7 (1 required + 4 optional) |

**Added in later messages:**
- Start fresh as a new app, approved (D1).
- Lock most settings for now (D7).
- Content (hero and sections) must be editable from settings, like eecd's hero settings (§4).
- Rework the payment verification page with stages; everything mobile-first (§7.1, D6).
- A reference number is a must; cross-shop matches give fraud protection, while same-shop matches show a full preview of who paid, how much and when (D8, §7.1).
- Customer self-pay link: QR code, the customer pays and uploads the screenshot themselves, gets a 3–5% discount, and their IP is saved. We changed IP tracking to phone + device ID + light fingerprint, because of CGNAT (§7.2).

## 3. Owner's answers to my questions
- Web addresses: **subdomain per shop for storefronts; admin on one domain** (my suggestion, accepted).
- SaaS console: **separate app**.
- Below-floor sale: **manager PIN + flag**.
- Product name: **no SaaS name for now**; Neil Lewz becomes client #1.
- Fresh start in a new folder: **yes**.

## 4. Key findings that changed the plan (details in RESEARCH.md)
1. **Data localisation:** Proclamation 1321/2024 Art. 22 says personal data must be stored on servers in Ethiopia, which may block a hosting setup outside Ethiopia. A lawyer is needed (PLAN §2.3).
2. **Bank receipt lookup exists** (CBE, Telebirr, BOA, Dashen…). Telebirr only answers Ethiopian IPs, so we need a verification worker hosted in Ethiopia.
3. **Gateways (Chapa, ArifPay, SantimPay…) had bank accounts frozen in Dec 2025.** They should be optional only.
4. **Competitor Bileh Tracker sells at 400–600 ETB/mo** with Dube, offline mode, Ethiopian calendar and Z reports. Our pricing must be re-justified.
5. **E-invoicing Directive 1142** covers SaaS sales-register providers.
6. **Referrals:** must be single-level and paid as credit only (anti-pyramid law).
7. **Missing features added:** Z report, returns, stock counts, expenses, wholesale tiers, variants, decimal quantities, IMEI/warranty.
8. **Cloudflare now recommends "vinext" over OpenNext** for new apps. Keep the code portable.

## 5. Side finding (other project)
GraceAndGrindNextGenV2 lets anyone sign up as OWNER, because the role is taken from signup metadata, and it lets admins grant themselves any permission. The owner was told; it is not yet fixed.

## 6. Screenshots
- `reference/planning-center-headcounts.png`: Check-Ins Headcounts page. Shows the colored module band, module tabs, an org switcher, a left sub-menu with a CONFIGURATION group, and category cards with colored header strips, rows and totals (🔒 built-in, ⚙ custom).
- `reference/planning-center-overview.png`: Check-Ins Overview. Shows pastel big-number tiles, trend stats ("▲52%, 11 more than last session"), breakdown lists with colored dots and progress bars, and a right-hand icon rail (notifications, tasks, chat).

## 7. Suggested next steps
1. Resolve PLAN.md §10 open questions: name, pricing, hosting, onboarding staff, self-pay discount.
2. Book an Ethiopian lawyer on hosting (Art. 22), the fraud registry, bank receipt lookup and e-invoicing.
3. Collect 20+ real receipt screenshots per provider (CBE, Telebirr, BOA…) for the regex and verifier work.
4. Then start **Phase A (Foundation)**.
