# Screen Map: Pilot (Phases A + B + pilot slice of C)

> **Status:** **approved 2026-10-16** (PLAN.md D22), with U7 changed by the owner: English is the default language and Gregorian the default calendar (D23).
> **Scope:** every screen the pilot needs (D11), the app shell, and wireframes for the screens that matter most. All wireframes are drawn at **360px wide first** (D6).
> **Builds on:** PLAN.md §3 (UI system), [DATA_MODEL.md](DATA_MODEL.md), [DATA_MODEL_B.md](DATA_MODEL_B.md), and the Planning Center references in [reference/](reference/).

---

## 0. Approved choices

| # | Choice | Why |
|---|---|---|
| U1 | **Two shells in one app.** A **POS shell** on paired devices: full screen, PIN login, no sidebar, auto-lock when idle. An **Admin shell** for owners and managers: sidebar on desktop, bottom tabs on phones. A manager on a POS device can open Admin after entering their PIN. | A cashier should never wander into settings. An owner checking sales from home shouldn't see a till. |
| U2 | **Sale flow: scan → tap payment tile → hold to confirm.** That's 3 touches for a cash sale. Customer details are optional and come **after** payment, on the success screen. Electronics are the exception: a serialized item asks for the IMEI scan when added. | PLAN §3 says the core sale takes 3 taps or fewer. Neil Lewz asks for customer details first, which slows every sale for something most sales don't need. |
| U3 | **Hold-to-confirm (0.8 s) with a filling ring**, then a full-screen success with sound and vibration, plus a **10-second Undo**. Undo is a void without a PIN, allowed only for the same cashier on the same device. It's recorded with reason `undo` and listed in the Z report. | A deliberate confirm prevents accidental sales; a fast undo fixes honest mistakes without calling the manager. Listing undos in the Z report stops it becoming a theft path. |
| U4 | **Negotiation never reveals the floor price to the cashier.** When the cashier edits a line price, the line turns **green** (fine: list or negotiated), or **orange "Manager PIN needed"** below the floor. The floor number itself shows only to people with `product:view_floor`. | If cashiers see the floor, customers learn it within a week and every sale goes to the floor. |
| U5 | **Home = Planning Center overview, modernised.** Four pastel number tiles with a trend line, then category cards with coloured dots and progress bars, then a list of open items. **Trends compare with the same weekday last week**, not yesterday. | Shops have strong weekly patterns (Saturday ≠ Monday). Comparing with yesterday would make every Monday look like a crisis. |
| U6 | **One fixed colour and icon per payment method, everywhere** (tiles, chips, Z report, Telegram): Cash green, Telebirr blue, CBE purple, Other banks teal, Dube slate. Always shown **with an icon and label**, never colour alone. | Low-literacy rule from PLAN §3, and colour-blind safe. Exact shades come with the design tokens. |
| U7 | **English is the default language; Amharic is one tap away** (owner decision). Each shop can change its default and each user can pick their own. All text comes from **message files** (`en.json`, `am.json`, …); see §0.1. Money uses Western digits with thousands separators and a currency label from the message file (`12,450 ETB` / `12,450 ብር`). Dates show the **Gregorian calendar by default**; the Ethiopian calendar is an option per shop and per user (D23). Noto Sans Ethiopic is loaded only when Amharic is in use. | Owner prefers English as the default. Ethiopic numerals are not used for money in practice. |
| U8 | **Touch sizes:** tap targets at least 48 px, body text at least 16 px, and the main action always in the bottom third of the screen (thumb zone). The POS works one-handed. | D6. Cheap Android phones, often used with one hand while holding goods. |

### 0.1 How languages work (message files)

- **Where:** `packages/i18n/messages/<locale>.json`, e.g. `en.json`, `am.json`, later `om.json` (Afaan Oromo).
- **Keys, not text, in code:** components use keys such as `t('pos.pay.total')`. The text lives only in the message files. Placeholders use ICU syntax: `"Paid {amount} by {method}"`, and plurals are handled too (`{count, plural, one {# item} other {# items}}`).
- **English is the source of truth.** `en.json` defines every key. A CI check fails if `am.json` (or any other enabled language) is missing a key or has a broken placeholder, which keeps the CLAUDE.md bilingual rule.
- **Adding a language = adding a file.** The list of languages is generated at build time from the files in `messages/`, and each file carries its own display name (`"_meta": {"name": "Afaan Oromoo"}`). Drop in `om.json`, rebuild, and it appears in the language picker. A language can be held back from users until it's complete.
- **Editing text = editing the file** and redeploying. Live editing without a deploy (text stored in the database, with an editor in the console) is possible later but not needed now; files in git are reviewed and versioned.
- **Shop-entered text** (product names, hero text) is not in message files. It is stored per record as `{ "en": …, "am": … }` (DATA_MODEL §1).

---

## 1. The shells

### 1.1 POS shell (paired device)

```
┌──────────────────────────────────┐
│ ☰ Counter 1 · Abebe     🔔2  🔒  │  ← device name, cashier, alerts, lock
├──────────────────────────────────┤
│                                  │
│          (screen content)        │
│                                  │
├──────────────────────────────────┤
│  🛒 Sell   🧾 Today   ⏸ Parked  ⋯ │  ← POS tabs
└──────────────────────────────────┘
```
- **⋯ More:** Returns, Shift (open/close), Price check, Serial lookup, Switch cashier, Open Admin (needs a manager PIN).
- **🔒 Lock:** back to the PIN screen. The device also auto-locks after an idle time set in Security settings (default 3 min).
- **Offline banner:** a thin bar under the header ("Offline: cash sales only, 3 waiting to sync"), from Phase F. Before Phase F it says "No connection: sales are paused".

### 1.2 Admin shell

**Phone (360px):**
```
┌──────────────────────────────────┐
│ [Shop ▾]                🔍  🔔•  │  ← shop switcher, search, alerts (red dot = fraud)
├──────────────────────────────────┤
│▌Inventory                        │  ← thin module accent bar + module name
│  Products · Receive · Counts · … │  ← module sub-menu as scrollable chips
├──────────────────────────────────┤
│          (screen content)        │
├──────────────────────────────────┤
│ 🏠 Home  🛒 Sell  📦 Stock  🔔 Alerts  ⋯ │
└──────────────────────────────────┘
```

**Desktop (≥1024px):**
```
┌───────────────┬─────────────────────────────────────────────┬────┐
│ [Shop ▾]      │▌Inventory                       🔍 Ctrl+K    │ 🔔 │
│               ├─────────────────────────────────────────────┤ ✅ │
│ 🏠 Home       │                                             │ 💬 │
│ 🛒 POS        │                                             │ ❔ │
│ 📦 Inventory  │              (screen content)               │    │
│   Products    │                                             │    │
│   Receive     │                                             │    │
│   Counts      │                                             │    │
│   CONFIGURATION                                             │    │
│   Suppliers   │                                             │    │
│   Settings    │                                             │    │
│ 💳 Payments   │                                             │    │
│ 👥 Customers  │                                             │    │
│ 📊 Reports    │                                             │    │
│ ⚙ Settings    │                                             │    │
└───────────────┴─────────────────────────────────────────────┴────┘
```
- The sidebar groups screens by module. Each module has a **CONFIGURATION** group, as in the Planning Center Headcounts screenshot.
- Each module is marked by a **thin accent bar** next to its name instead of Planning Center's full-width coloured band.
- **Right rail:** Alerts, Approvals (Phase C), Messages, Help.
- Modules the tenant hasn't enabled are hidden, not greyed out.

---

## 2. Screen inventory (pilot)

**Tags:**
- 🟢 = needed for the pilot
- ⚪ = later phase, listed so the navigation leaves room for it
- `P` = phone-first screen used daily
- `D` = mostly used on desktop

### Access (Phase A)
| Screen | Who | Notes |
|---|---|---|
| 🟢 Owner sign-in | Owner, manager | Google, or email/phone + password |
| 🟢 Shop picker | Multi-shop users | Skipped when there's only one shop |
| 🟢 Pair this device `P` | Owner | Owner's phone shows a QR code; the new device scans it, gets a name ("Counter 1") and a branch |
| 🟢 PIN screen `P` | Staff | Grid of staff photos/initials → 6-digit PIN pad. Lockout message after 5 failures (M9) |
| 🟢 Step-up PIN sheet `P` | Anyone | Bottom sheet: "Manager PIN needed: below-floor price". Pick a manager, enter PIN. Used for every PIN action |
| 🟢 Impersonation banner | Tenant users | "Support is viewing your shop (read-only) until 15:40" |

### POS (Phase B)
| Screen | Notes |
|---|---|
| 🟢 Sell `P` | §3.1 |
| 🟢 Pay sheet `P` | §3.2 |
| 🟢 Digital payment capture `P` | §3.3 |
| 🟢 Success + receipt `P` | §3.4 |
| 🟢 Parked tickets `P` | List with age; resume or discard (discarding is audited) |
| 🟢 Today's sales `P` | This shift's sales; tap one → detail → Void (reason + PIN) |
| 🟢 Returns `P` | Scan receipt QR or type receipt no. → pick lines → scan the serial (must match) → restock / write off → refund method |
| 🟢 Shift open `P` | Opening float on a big keypad |
| 🟢 Shift close / Z `P` | §3.5 |
| 🟢 Price check `P` | Scan → name, price, stock (no floor) |
| 🟢 Serial lookup `P` | IMEI → product, status, sold when/by whom/price, warranty until |

### Payments (pilot slice of C)
| Screen | Notes |
|---|---|
| 🟢 Review queue `P` | Swipeable cards, one per pending digital tender. §3.6 |
| 🟢 Payment detail | Receipt image, read vs expected, check rows, 📋 copy reference, review history |
| ⚪ Self-pay page (customer) | Phase C |

### Catalog & Inventory (Phase B)
| Screen | Notes |
|---|---|
| 🟢 Products `P/D` | Saved-view tabs: All · Low stock · Out of stock · No photo · Archived. Cards on phone, table on desktop. Tap → side sheet |
| 🟢 Product editor `P/D` | Photos (editor from PLAN §7.7), name en/am, category, kind (standard/serialized/weighed), variants, prices, floor, wholesale tiers, barcodes. A price change > 50% shows "200,000 → 20,000 (−90%)?" + PIN |
| 🟢 Receive stock `P` | Supplier, invoice photo, scan items → qty + cost; for serialized items scan each IMEI. Draft until posted |
| 🟢 Stock count `P` | Blind by default. Scan → type counted qty. Submit → owner reviews differences → post |
| 🟢 Adjust / write-off `P` | Reason required; large ones need a PIN |
| 🟢 Stock history | The ledger for one item, with links to each sale/receipt/count |
| 🟢 Labels `D` | Pick items → print Code 128 + QR labels (ported from Neil Lewz) |
| 🟢 Suppliers | Simple list |

### Customers (core)
| Screen | Notes |
|---|---|
| 🟢 Customers `P` | Search by phone or name |
| 🟢 Customer detail | Purchases, serials owned with warranty status |

### Home, Alerts, Reports
| Screen | Notes |
|---|---|
| 🟢 Home overview `P/D` | §3.7 |
| 🟢 Alerts center `P/D` | Number tiles per category → category cards → evidence side sheet with actions (PLAN §6.3) |
| 🟢 Z report history | List of closed shifts; each opens the Z report |
| 🟢 Sales report (light) | By day, by item, by cashier, by payment method; gross profit |
| ⚪ Expenses, Dube, full reports | Phase D |

### Staff, devices, settings, audit (Phase A)
| Screen | Notes |
|---|---|
| 🟢 Staff | List with role and status. Add staff = name, phone (optional), role; the person sets their own PIN on a paired device |
| 🟢 Staff detail | Role, branches, permission overrides (Owner only), sessions, Suspend |
| 🟢 Devices | Paired devices, last seen, Revoke |
| 🟢 Settings | Tabs in the URL, search box, 🔒 "Contact support" on locked items (PLAN §4) |
| 🟢 Activity | Owner-only global audit timeline with filters (who, what, when, PIN used). Every record also has its own timeline tab |

---

## 3. Key screens

### 3.1 Sell

```
┌──────────────────────────────────┐
│ ☰ Counter 1 · Abebe     🔔2  🔒  │
├──────────────────────────────────┤
│ [🔍 Search or scan…        ] [📷]│  ← typing searches; a USB/BT scanner just works
├──────────────────────────────────┤
│ Phones  Accessories  Chargers  … │  ← category chips
│ ┌──────┐ ┌──────┐ ┌──────┐       │
│ │ 📱   │ │ 🎧   │ │ 🔌   │       │  ← photo tiles, name + price
│ │A15   │ │Buds  │ │20W   │       │
│ │18,500│ │2,300 │ │  950 │       │
│ └──────┘ └──────┘ └──────┘       │
│              …                   │
├──────────────────────────────────┤
│ 3 items              21,750 ብር ▲ │  ← cart bar; tap or swipe up to expand
│ [ ⏸ Park ]   [   Pay  21,750 ➜  ]│
└──────────────────────────────────┘
```

**Behaviour:**
- **Scanning:**
  - a scan adds the item with a beep
  - scanning an **IMEI that's already in stock** adds that exact phone in one scan
  - scanning a serialized product's barcode asks "Scan IMEI"
- **Expanded cart:**
  - each line has qty −/+ and a tappable price
  - editing the price opens the keypad with the U4 colours
  - swipe left on a line to remove it
- **Weighed items:** the keypad asks for kg (3 decimals).
- **Wholesale tier prices** apply automatically when the quantity reaches the tier; the line shows a "Wholesale" chip.

### 3.2 Pay sheet

```
┌──────────────────────────────────┐
│ Total                 21,750 ብር  │
├──────────────────────────────────┤
│ ┌───────────┐ ┌───────────┐      │
│ │ 💵 Cash   │ │ 📱Telebirr│      │  ← method tiles in fixed colours (U6)
│ └───────────┘ └───────────┘      │
│ ┌───────────┐ ┌───────────┐      │
│ │ 🏦 CBE    │ │ 🏦 Other  │      │
│ └───────────┘ └───────────┘      │
│ [ Split payment ]                │
├──────────────────────────────────┤
│        ◯ Hold to confirm         │  ← appears after a method is picked
└──────────────────────────────────┘
```
- **Cash:**
  - A "Cash given" keypad is optional and defaults to the exact amount.
  - Quick buttons show the next round notes (22,000 · 25,000).
  - The change is shown in huge text.
- **Digital:** opens §3.3 before the confirm.
- **Split payment:** add tenders until the remaining amount is 0.
- **Dube** appears here from Phase D.

### 3.3 Digital payment capture

```
┌──────────────────────────────────┐
│ 📱 Telebirr          21,750 ብር   │
│ Pay to: 09•• ••• 123  [📋 Copy]  │
├──────────────────────────────────┤
│ [ 📷 Photo of receipt ]          │
│ [ 📋 Paste SMS / link ]          │
│ [ ⌨ Type reference ]   (flagged) │
├──────────────────────────────────┤
│ ✔ Reference found   CJP9OSP9WZ   │
│ ✔ Amount           21,750 ብር     │
│ ✔ Paid to your account           │
│ ✔ Never used before              │
│ ⚠ Image looks like one from 3 Oct│  ← near-duplicate image → Suspicion
├──────────────────────────────────┤
│ [ Accept: review later ]  [Reject] │
└──────────────────────────────────┘
```
- Capture order: QR/link first, then OCR, then manual (PLAN §7.1). Manual entry is allowed but marked `manual`.
- **✖ Reference used before (same shop)** shows the full earlier sale: when, how much, which cashier, link. The tender is blocked and a Fraud alert is raised.
- In the pilot there is no bank lookup, so the best result is "Accept: review later". The tender becomes `pending_verification` and goes to the review queue.

### 3.4 Success + receipt

```
┌──────────────────────────────────┐
│              ✅                  │
│           21,750 ብር              │
│        Telebirr · B1-C1-000318   │
│                                  │
│ [ ↩ Undo  (8) ]                  │  ← 10-second countdown (U3)
├──────────────────────────────────┤
│ Customer phone (optional)        │
│ [ 09________ ]  → warranty, SMS later │
│ [ 📤 Send receipt ] [ 🖨 Print ] │
├──────────────────────────────────┤
│ [          New sale  ➜         ] │
└──────────────────────────────────┘
```
- **Send receipt:** shares a receipt link through the phone's share sheet (Telegram, etc.). The link shows the receipt with the "not a fiscal receipt" label.
- **Print:** optional Bluetooth 58mm (Phase B if the pilot shop has a printer, otherwise later).
- For serialized items, the phone field shows "Recommended: needed for warranty lookup".

### 3.5 Shift close / Z report

```
┌──────────────────────────────────┐
│ Close shift · Counter 1          │
├──────────────────────────────────┤
│ 💵 Cash                          │
│  200 × [ 5 ]   100 × [12 ]       │  ← denomination calculator
│   50 × [ 3 ]    10 × [ 8 ]  …    │
│  Counted 2,430 · Expected 2,480  │
│  Difference   −50 ብር  🟠         │
├──────────────────────────────────┤
│ 📱 Telebirr  Expected 41,200     │
│  Counted [ 41,200 ] (from app)   │
│ 🏦 CBE       Expected 18,500     │
│  Counted [ 18,500 ]              │
├──────────────────────────────────┤
│ Voids 1 · Undos 2 · Returns 0    │
│ Below-floor 1 · Parked left 0    │
├──────────────────────────────────┤
│ [       Close shift & send Z     ]│
└──────────────────────────────────┘
```
- **Expected amounts are hidden until the cashier has entered every counted amount.** Otherwise they would just copy the expected numbers (same idea as the blind stock count).
- Differences above the threshold raise a Suspicion alert.
- The Z report goes to the owner's Telegram on close.

### 3.6 Payment review queue

```
┌──────────────────────────────────┐
│ To verify (4)                    │
├──────────────────────────────────┤
│ ┌──────────────────────────────┐ │
│ │ [receipt img]  📱 Telebirr   │ │
│ │                21,750 ብር    │ │
│ │ Ref CJP9OSP9WZ  [📋]         │ │
│ │ Expected 21,750 · Read 21,750│ │
│ │ Abebe · 14:05 · B1-C1-000318 │ │
│ └──────────────────────────────┘ │
│  ← swipe: Fake    swipe: Verified →│
│ [ ❌ Reject ] [ ⚠ Fake ] [ ✅ OK ]│
└──────────────────────────────────┘
```
- The owner checks their Telebirr/CBE app or SMS (copy the reference → search), then taps Verified. Fake and Reject ask for a reason.
- The same cards and buttons appear in Telegram (pilot: basic version).

### 3.7 Home overview

```
┌──────────────────────────────────┐
│ ┌──────────────┐┌──────────────┐ │
│ │  84,300 ብር   ││     37       │ │  ← pastel tiles
│ │ SALES TODAY  ││    SALES     │ │
│ │ ▲12% vs Sat  ││ ▲4 vs Sat    │ │
│ └──────────────┘└──────────────┘ │
│ ┌──────────────┐┌──────────────┐ │
│ │      4       ││    1 🟣      │ │
│ │ TO VERIFY    ││  ALERTS      │ │  ← magenta when any fraud alert
│ └──────────────┘└──────────────┘ │
├──────────────────────────────────┤
│ By payment method                │
│ ● Cash       24,600 ████░░░░     │  ← coloured dots + bars (like "Times")
│ ● Telebirr   41,200 ███████░     │
│ ● CBE        18,500 ███░░░░░     │
├──────────────────────────────────┤
│ Top items · Low stock · Staff    │  ← category cards with header strip
│ …                                │
└──────────────────────────────────┘
```
- On desktop the 4 tiles sit in one row and the cards in a 2–3 column grid, as in the Planning Center Overview screenshot.
- Every tile and card row is tappable and opens the filtered list.

---

## 4. Patterns used everywhere

- **Lists:**
  - saved-view tabs plus filter chips
  - cards on phone, table on desktop
  - tapping opens a **side sheet** (desktop) or a full-screen sheet (phone), so you never lose your place
- **Record timeline:** every record has an Activity tab, read from the audit log ("Price changed 18,500 → 17,900 by Sara, PIN by Meron, 14:02").
- **Errors:** inline under the field or as a small toast with a retry, never a modal wall (PLAN §3). Network errors keep the user's input.
- **Confirming destructive actions:** a reason picker + PIN sheet instead of "Are you sure?" dialogs.
- **Empty states:** one sentence plus the main action ("No products yet. [Scan first product]").
- **Loading:** skeletons shaped like the content; the POS never shows a full-screen spinner.
- **Search:** Ctrl+K on desktop, 🔍 in the header on phones. Searches products, barcodes, IMEIs, receipt numbers, references, customers and staff in one box.

---

## 5. What gets validated in the pilot

| Question | How we'll know |
|---|---|
| Is the cash sale really ≤ 3 touches? | Count touches in a recorded session; median sale time under 10 s for a scanned item |
| Do cashiers understand hold-to-confirm? | Misfires and undos per shift in the Z report |
| Is reviewing pending payments a burden for the owner? | Time from sale to verified; queue length at end of day |
| Do the shift-close differences catch real problems? | Number of non-zero differences and what the owner found |
