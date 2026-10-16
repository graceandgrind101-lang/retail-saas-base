# The Guide: set up, understand, test and keep building

One document for everything, written as if you have never seen this project. Read it top to bottom once;
afterwards use the table of contents. It is kept up to date as the project grows (the last section says how).

**Contents**
1. [What this is, in plain words](#1-what-this-is-in-plain-words)
2. [What exists today (and what does not)](#2-what-exists-today-and-what-does-not)
3. [One-time setup on your computer](#3-one-time-setup-on-your-computer)
4. [Run it and walk through every screen](#4-run-it-and-walk-through-every-screen)
5. [How it works inside (the ideas, no code needed)](#5-how-it-works-inside)
6. [The map of the folders](#6-the-map-of-the-folders)
7. [Daily workflow: how we work together](#7-daily-workflow-how-we-work-together)
8. [The checks: what they are and how to run them](#8-the-checks)
9. [Everyday commands](#9-everyday-commands)
10. [Create a real shop (tenant) and use a second computer or phone](#10-create-a-real-shop-and-use-other-devices)
11. [Secrets, tokens and safety rules](#11-secrets-tokens-and-safety-rules)
12. [When something goes wrong](#12-when-something-goes-wrong)
13. [The road ahead: what each future phase will add and how you will test it](#13-the-road-ahead)
14. [Your to-do list (things only you can do)](#14-your-to-do-list)
15. [Keeping this guide current](#15-keeping-this-guide-current)

---

## 1. What this is, in plain words

A cash-register and shop-management system sold to many shops at once ("multi-tenant": each shop is a
**tenant**, and one shop can never see another's data). It is built for Ethiopian shops, electronics first.
Neil Lewz, the live shop, will become tenant number 1 one day.

Principles you will see everywhere:
- **Phone first.** Everything is designed for a 360px-wide phone screen first, then widened for a desktop.
- **English by default, Amharic as an option.** Every word on screen lives in a message file, never in code.
  The Gregorian calendar is the default, the Ethiopian calendar is an option.
- **Money and security rules are tested, and the tests are themselves tested** (we break a rule on purpose and
  confirm a test notices). That is called mutation testing.
- **Nothing secret is ever written into the project.** Passwords and keys live only in a local file that git ignores.
- **Cheap and portable.** Free or cheap cloud tiers now; moving to Ethiopian servers later should be a
  settings change, not a rewrite.

The plans, in the order to read them: `docs/CONVERSATION_CONTEXT.md` (how we got here) → `PLAN.md` (the master
plan and every decision, numbered D1, D2…) → `RESEARCH.md` → `docs/DATA_MODEL.md` and `docs/DATA_MODEL_B.md`
(the database) → `docs/SCREENS.md` (every screen) → `docs/PHASE_A_PLAN.md` (the build order and progress).

## 2. What exists today (and what does not)

We are in **Phase A: Foundation** (tasks A0 to A16). Phase A builds the safe base every later feature stands on.

**Built and working (A0 to A15):**

| Area | What it does |
|---|---|
| Money and rules | Money in santim (no rounding surprises), tax maths, quantities in thousandths, one rounding rule |
| Database | One database for all shops; every shop's rows carry a shop id and are walled off by the database itself (row-level security) |
| Audit log | Every change is written to a tamper-evident chain (each entry locks in the one before it); even the database owner cannot edit it undetected |
| Sign-in | Staff sign in with a PIN on a connected device. Account sign-in (email/Google) is built on the server side but needs a real Supabase project (your to-do) |
| Devices | A till is connected with a one-time code; PINs work only on a connected device; 5 wrong PINs lock the person and the till for 15 minutes |
| Permissions | Roles (owner, manager, cashier, viewer), personal exceptions, rules such as "you cannot give a permission you do not hold", "the last owner can never be removed" |
| Alerts | Things the owner should know (for example a PIN lockout) with seen / resolved / dismissed |
| Languages | English and Amharic, Gregorian and Ethiopian calendars, a check in CI that every text exists in both languages |
| Look and feel | A kit of buttons, panels, PIN pad etc. with light/dark themes and checked colour contrast |
| Shells | The admin app (sidebar on desktop, bottom tabs on a phone, Ctrl+K search) and the till app (PIN lock, idle lock) |
| Settings | 14 settings in 7 sections; most are locked on purpose; sensitive ones ask for your PIN |
| Staff, devices, activity | Add people, set PINs, change roles, suspend/archive, personal exceptions; connect and disconnect devices; the Activity timeline of everything that happened |

**Not built yet (so do not look for it):** selling, products, stock, payments, customers, reports, the
platform console, the Telegram bot, offline mode. These are Phases B to G (section 13).

## 3. One-time setup on your computer

You need a Windows computer with an internet connection. Everything runs locally; nothing is sent anywhere.

### 3.1 Install these once

| Tool | Why | How to check it is installed |
|---|---|---|
| **Git** | keeps the history and syncs with GitHub | `git --version` |
| **Node.js 22 or newer** | runs the app | `node --version` |
| **pnpm** (the project pins version 12.11.2) | installs and runs the pieces | `pnpm --version` (if missing: `corepack enable`, then `corepack prepare pnpm@12.11.2 --activate`) |
| **Docker Desktop** | runs the local database | open it; wait until it says "running" |
| **VS Code** | where you read files and use Claude Code | optional but assumed |

### 3.2 Get the project and prepare it

Open a terminal in VS Code (Terminal menu, New Terminal; Git Bash or PowerShell both work). Type these one at a time:

```bash
# 1. Get the code (skip if the folder already exists on your computer)
git clone https://github.com/MrSurfer/retail-saas-base.git retail-saas
cd retail-saas

# 2. Install every dependency (a few minutes the first time)
pnpm install

# 3. Start the local databases (Docker Desktop must be running; the first time downloads ~350 MB)
pnpm db:up

# 4. Create your private settings file with fresh random secrets, and prepare the database
pnpm dev:setup

# 5. Create the demo shop. It prints a connection code: keep it for later
pnpm dev:seed

# 6. Only for the browser tests (section 8): download the test browser once
pnpm --filter @retail/web exec playwright install chromium
```

What each step did:
- `pnpm db:up` started two databases in Docker: your **development data** on port 54322 (kept between restarts)
  and a **throwaway test** database on port 54323 (wiped whenever it stops; only the automatic tests use it).
- `pnpm dev:setup` wrote `apps/web/.env.local` with newly generated secrets and applied the database setup.
  It never overwrites a file that already exists. This file is git-ignored: it never leaves your computer.
- `pnpm dev:seed` created a demo shop with an owner, a manager, a cashier, two sample alerts and a one-time
  connection code. Run it again any time for a fresh code (a code works once and lasts 10 minutes).

## 4. Run it and walk through every screen

```bash
pnpm dev
```

Open <http://localhost:3000/sign-in>. Stop with **Ctrl+C**. Demo PINs: **Owner 2580, Manager 4829, Cashier 7391.**

### 4.1 As the owner (the whole admin app)

1. **Sign in.** Press *Sign in as the demo owner* (a developer shortcut that only exists on your computer). You land on **Home**: tiles with the open alerts.
2. **Alerts.** Open *Alerts* (menu or bell). Two sample alerts. Tap one: *Mark as seen*, then *Resolve* with a note. *Show closed alerts* keeps the history. A closed alert cannot be reopened.
3. **Search.** Press **Ctrl+K**, type `ale`, press Enter.
4. **Your preferences.** Open the shop name (top left): *Language* (English / አማርኛ), *Calendar* (Gregorian / Ethiopian), *Theme* (device / light / dark), *Sign out*. Check that the dates change when you change the calendar.
5. **Settings** (Configuration, Settings; on a phone: More, Settings). Sections are tabs.
   - *Inventory, Low-stock level*: change it, *Save*, reload: it stays. Type `-3`: refused with a message.
   - *Payment accounts*: everything greyed with a lock and "Contact support to change this". **Locked on purpose**: this proves a locked setting cannot be changed.
   - *Business profile, Shop phone number*: Save asks for your PIN (2580). A wrong PIN saves nothing.
   - *Language and calendar, Default language* = አማርኛ: the whole app switches for anyone who has not chosen their own.
6. **Staff** (CONFIGURATION group in the sidebar, Staff; on a phone: More).
   - *Add a person*: name "Selam Bekele", role Cashier, PIN 482915. You land on her page and it says "Has a PIN".
   - On her page try *Suspend*, then *Reinstate*; try *Change role*; add a personal exception ("Not allowed", pick a permission, give a reason) and remove it. Open *Archive*: it asks you to **hold** the button (so a stray tap cannot archive someone).
   - Open **Demo Owner**: you cannot suspend or demote yourself or the last owner (those buttons are absent, and the database refuses a hand-made request too).
7. **Devices.** *Connect a new device* shows a code (valid 10 minutes, works once). Use it in step 8.1 below. The list shows who connected each device and when it was last used. *Disconnect* (hold) ends that till and signs out everyone on it. A locked till shows *Unlock*.
8. **Activity.** The timeline now tells the story in sentences: "Selam Bekele was added", "A code to connect a device was made", "The setting “Low-stock level” was changed"... newest first, with *Show older* at the bottom. A person's own page shows only the entries about that person.
9. **Phone view.** Press **F12**, then Ctrl+Shift+M (device toolbar), choose Pixel 7 or width 360. The sidebar becomes bottom tabs; lists become cards; nothing scrolls sideways.

### 4.2 As a till (cashier or manager with a PIN)

1. Sign out. On the sign-in page type the **code** `pnpm dev:seed` printed, a device name (Counter 1), press **Connect**.
2. Pick **Demo Cashier** and enter **7391**. Wrong PINs show a message; **five wrong in a row** lock the person and the till for 15 minutes and raise an alert (see it as owner under Alerts, and in Activity).
3. You are in the till: header with device and cashier; tabs *Sell, Today, Parked, More*. The sale screen itself is Phase B, so those pages say so.
4. **Lock** returns to the PIN screen. Leave the till alone for 3 minutes and it locks itself and says why.
5. As the **manager**, *More, Open the admin app*. As the **cashier**, you see no Alerts, Staff, Devices or Activity (typing the address just sends you home).

### 4.3 What "working" looks like

The point of these walks is to see the *rules*, not only the screens: a locked setting stays locked, a PIN
works only on a connected device, a cashier cannot see the owner's pages, the last owner is protected, every
action appears in Activity. If any of those fails, tell me; it is a bug.

## 5. How it works inside

You do not need this to use the app, but it explains why the screens behave as they do.

- **One database, many shops.** Every row has a `tenant_id`. The database (PostgreSQL) itself hides other shops' rows
  (*row-level security*). The web app signs in to the database as a deliberately limited user, then for each request
  tells the database "I am staff member X of shop Y". If code forgot a filter, the database would still refuse.
- **Rules live in the database too.** Things such as "only grant permissions you hold" are enforced in database
  functions, not just in screens, so a hand-crafted request cannot get around them.
- **The audit log is a chain.** Each entry stores a fingerprint of the previous one, per shop. Change or delete
  an old entry and every later fingerprint breaks, which `verify_chain` detects. A nightly job copies the chain's
  latest fingerprint to storage outside the database (Cloudflare R2) so even the database owner cannot quietly rewrite history.
- **PINs are never stored.** A PIN is mixed with a server secret ("pepper") and slow-hashed. A copy of the database alone cannot reveal PINs.
- **Devices.** A manager makes a one-time code; the new device exchanges it for a device token (stored in a
  secure cookie, never shown). A PIN only works together with a valid device token.
- **Settings.** One list in `packages/core` describes every setting (name, type, default, locked/editable/hidden, needs-PIN). A locked setting is refused by the database function itself.
- **Words.** `packages/i18n/messages/en.json` is the source of every text; `am.json` must have the same keys
  (CI fails otherwise). Adding a language is adding one file.
- **Pure core.** `packages/core` holds money, permissions, settings and calendar rules with no database or screen code,
  so they are easy to test exhaustively.
- **The web app** (`apps/web`) is Next.js. Each API address is a thin file that calls a plain handler in `lib/`,
  which is tested against a real database.

## 6. The map of the folders

```
retail-saas/
  CLAUDE.md            instructions Claude Code reads at the start of every session
  PLAN.md              master plan + numbered decisions (D1...)
  RESEARCH.md          research with sources
  docs/                this guide, data model, screens, phase plan, decisions (adr/), reference material
  apps/web/            the shop app (admin + till). app/ = pages, lib/ = server logic, components/, e2e/ = browser tests
  apps/console, bot, verifier   empty for now (later phases)
  packages/core/       pure rules: money, permissions, settings registry, navigation, calendar, activity sentences
  packages/db/         migrations (SQL), database functions' TypeScript side, scripts, database tests
  packages/i18n/       message files (en.json, am.json), formatters, the i18n check
  packages/ui/         buttons, panels, PIN pad, tokens (colours), light/dark theme
  infra/dev-db/        the Docker setup for the local databases
  scripts/             setup and safety scripts (dev-setup, secrets, brand check)
```

## 7. Daily workflow: how we work together

1. **You say what you want** in plain words ("continue", "add X", "why does Y happen?"). For ideas, we talk first
   and I give one clear recommendation, not a list of options.
2. **Decisions get written down** in `PLAN.md` (numbered D-entries) the moment you approve them, so we never
   ask the same question twice. Open questions live in `PLAN.md` section 10.
3. **I build in small tasks** listed in `docs/PHASE_A_PLAN.md` (A0, A1, ...). Each task ends with its tests and
   the whole project's checks green, a note in the progress table, and a git commit.
4. **I do not start the next phase until you say so.** (You said "start Phase A" on 2026-10-16.)
5. **Pushing to GitHub**: you say "push" and paste a token (section 11). I use it for that one command only.
6. **Checking my work**: run section 4's walkthrough for the new screens, or just tell me "show me how to test it".
   `docs/PHASE_A_PLAN.md` says what each task's "done when" test is.
7. **Starting a new Claude Code session**: it reads `CLAUDE.md` automatically, which points to everything else,
   so a fresh session has the full context.

## 8. The checks

| Check | Command | What it proves | When to run |
|---|---|---|---|
| Everything automatic | `pnpm run ci` | brand-name check, i18n check, lint, types, ~1,400 tests (core, i18n, ui, database, web) | before every commit |
| Production build | `pnpm build` | the app compiles for real | before every commit |
| Real browser | `pnpm --filter @retail/web e2e` | drives Chromium on a Pixel 7 and a 1280px desktop through the screens, including the accessibility scan | after screen changes |
| Database security | `pnpm db:check` | every tenant table has isolation switched on, no function leaks, etc. | after database changes |
| Audit chains (no storage needed) | `pnpm db:verify-audit` | every shop's audit chain is intact (an edited or deleted entry breaks it) | any time, and before a release |
| Audit anchor | `pnpm db:anchor` | copies each shop's audit fingerprint to R2 and verifies the chain (needs R2 keys, see section 14) | nightly later |

GitHub runs `ci` and the browser tests on every push: the **Actions** tab of the repository shows green ticks or
red crosses. Red means do not trust the latest push; tell me.

## 9. Everyday commands

```bash
pnpm dev                 # start the app at http://localhost:3000
pnpm dev:seed            # new demo connection code (and demo shop if missing)
pnpm db:up / db:down     # start / stop the local databases (data is kept)
pnpm db:reset            # DELETE all local data and start empty (then dev:setup and dev:seed again)
pnpm db:migrate          # apply new database changes to your dev database
pnpm db:verify-audit     # check every shop's audit chain (needs DATABASE_ADMIN_URL, see below)
pnpm db:check            # check every table is isolated (needs DATABASE_ADMIN_URL)
pnpm run ci              # all automatic checks
pnpm build               # production build
pnpm --filter @retail/web e2e   # browser tests
pnpm secrets:generate    # print fresh random secrets (to paste into a hosting service, never into git)
git status               # what changed
git log --oneline        # the history, one line per commit
```

Locally the two commands that need `DATABASE_ADMIN_URL` are run like this (bash):

```bash
DATABASE_ADMIN_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres pnpm db:check
DATABASE_ADMIN_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres pnpm db:verify-audit
```

(PowerShell: `$env:DATABASE_ADMIN_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"; pnpm db:check`.)
That address and password belong to your throwaway local container only. Expect "ok" and "N of N shops verified".

## 10. Create a real shop and use other devices

**A shop for a real pilot customer** (run locally against your dev database for now; later against the hosted database):

```bash
# DATABASE_ADMIN_URL is the owner connection; locally it is postgresql://postgres:postgres@127.0.0.1:54322/postgres
pnpm tenant:create --slug nati-mobile --name "Nati Mobile" --industry electronics --plan pro \
  --owner-email owner@example.com --owner-name "Nati"
```

It prints the owner's invitation token **once**; copy it then. (Accepting the invitation needs account sign-in, which needs the Supabase project: section 14.)

**Your phone on the same Wi-Fi:** run `pnpm dev`, find your computer's IP (`ipconfig`), and open `http://<that ip>:3000`
on the phone. Note that the app insists requests come from `NEXT_PUBLIC_APP_URL` (in `apps/web/.env.local`), so for phone testing set that
to the same address and restart. Browsers also refuse some features on plain http from another device; for real
phone testing the hosted preview (Phase A16) is better.

**Putting the app on the internet (Cloudflare Workers).** The packaging is in place (`apps/web/wrangler.jsonc`,
`open-next.config.ts`). GitHub builds the bundle on every push (job "workers-bundle"). The first real deployment
needs three things from you (section 14: Supabase project, Cloudflare login, a hosted database) and one of:
Windows Developer Mode switched on (Settings, For developers) so `pnpm --filter @retail/web cf:build` works on your computer, or
deploying from GitHub. I will walk you through it command by command when we reach it; **nothing is deployed without you**.

## 11. Secrets, tokens and safety rules

- **Never** paste secrets into files, documents or commit messages. Only `.env.example` files (empty templates) are in git.
- `apps/web/.env.local` holds your local secrets; git ignores it. Losing it only means running `pnpm db:reset`, deleting it, and `pnpm dev:setup` again.
- The app **refuses to start** if a secret is missing, too short or reused.
- The **developer sign-in** shortcut works only with `ALLOW_DEV_SIGN_IN=1` in a non-production run; a production build that sees the setting at all refuses to start.
- **GitHub token for pushing:** you paste it into the chat with "push". I use it for one command with the
  password prompt disabled and never save it anywhere. **Revoke the token** at GitHub (Settings, Developer settings,
  Personal access tokens) whenever you want; create a new one next time. Anything pasted in chat is something you
  may want to revoke when you finish a work session.
- Real keys later (Supabase, Cloudflare R2, hosting) go only into the hosting service's secret settings and your local `.env.local`.

## 12. When something goes wrong

| Symptom | Fix |
|---|---|
| Commands say they cannot reach the database | Docker Desktop is not running. Open it, wait, `pnpm db:up` |
| "This code is not valid or has expired" | Codes last 10 minutes and work once. `pnpm dev:seed` for a new one |
| Port 3000 busy | Stop the earlier `pnpm dev` (Ctrl+C) or close the other app |
| Clean start | `pnpm db:reset`, delete `apps/web/.env.local`, `pnpm dev:setup`, `pnpm dev:seed` |
| `pnpm start` says "ALLOW_DEV_SIGN_IN must not be set" | Intended. Use `pnpm dev`, or remove that line for a production-style run |
| "Developer sign-in" button missing | `ALLOW_DEV_SIGN_IN=1` is not in `.env.local`, or this is a production run |
| Tests fail only with timeouts after a restart | Docker was starting up; wait a minute, run again |
| GitHub Actions shows red | Open the failed run, copy the red lines to me |
| Browser tests say a browser is missing | `pnpm --filter @retail/web exec playwright install chromium` |
| Anything else | Copy the exact error text to me; do not retype it |

## 13. The road ahead

Each phase ends with something you can try. Phase A's remaining step is the exit pass (A16).

| Phase | What it adds | What you will test (in plain terms) |
|---|---|---|
| **A16 Exit pass** (in progress: sweep, chain verify, smoke tests and deployment packaging are done; real R2 anchor and the first deployment wait for you) | Full isolation sweep, audit-chain verify, anchor to R2, first deployment to Cloudflare, a browser smoke test pair→PIN→shells→settings | Open the deployed preview on your phone; pair it; sign in with a PIN; see the settings; check the exit list in `docs/PHASE_A_PLAN.md` section 2 |
| **B Sell & stock** | Products and variants, photos, the sale screen with payment tiles, receipts, returns/voids, shift close, stock ledger and counts, labels, scanner | Ring up a sale on your phone like at the counter; return it; close a shift; count stock. The goal is "Neil Lewz flows reproduced" |
| **C Money integrity** | Floor prices and discounts with PIN approval, payment receipt checks (duplicate reference, image fingerprints), review queue, alerts | Try to sell below the floor (blocked); upload the same receipt twice (caught) |
| **Pilot cut** | A + B + the first slice of C, for two or three real shops | A real shop uses it for a week |
| **D Merchant value** | Credit (Dube), expenses and profit reports, exports, Telegram bot, serial numbers and warranty | Run a full week of a shop's books |
| **E Onboarding and platform** | Onboarding mini-app, shared product catalogue, the platform console, backups and a restore drill | Onboard a second shop in under a day |
| **F Offline** | Works without internet and syncs back | Turn off Wi-Fi, sell for an hour, turn it on: nothing lost or doubled |
| **G Later** | Storefront, themes, multi-branch, trade-ins, loyalty, SMS, e-invoicing, Neil Lewz migration | decided when we get there |

**How every future task will be walked through with you** (the same pattern as 4.1 and 4.2): I add to section 4 a
short numbered list ("do this, you should see that") for each new screen, plus any new command in section 9, and
record the "done when" test in `docs/PHASE_A_PLAN.md` (or the matching phase plan). You never need to read code to verify a task.

## 14. Your to-do list

Only you can do these; none block what I am building next, except where marked.

1. **Supabase project (free tier)** for real email/Google sign-in. Needed before a real owner can log in on a hosted app. Send me the project URL and the anon key (they are public-by-design); keep the service key private (paste it only into the hosting service).
2. **Cloudflare R2 bucket and API token** (for the audit-chain anchor). Needed for A16's "anchor against real R2". Steps: Cloudflare dashboard, R2, Create bucket; then Manage R2 API Tokens, create a token limited to that bucket (Object Read & Write). Put the four values (`R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`) in your local environment only; tell me when they are set, never paste them in chat.
3. **Cloudflare Workers deploy login**: when I reach the deploy step I will tell you the exact command; it opens a browser for you to approve.
4. **Revoke the GitHub token** whenever a session ends.
5. **Have a native Amharic speaker review** `packages/i18n/messages/am.json` before any pilot (I wrote it without a reviewer).
6. **Send `docs/LAWYER_BRIEF.md`** to an Ethiopian lawyer.
7. **Decide the product name** (not blocking; the brand is configuration, not code) and **the partnership / legal entity** (needed before signing a pilot shop).
8. **Recruit 2 to 3 electronics pilot shops** and collect 20+ receipt screenshots per payment provider (CBE, Telebirr, BOA) for Phase C.

## 15. Keeping this guide current

When a task lands I add: its walkthrough in section 4, new commands in section 9, new rows in sections 2 and 13,
and any new to-do for you in section 14. `docs/LOCAL_TESTING.md` now just points here.
