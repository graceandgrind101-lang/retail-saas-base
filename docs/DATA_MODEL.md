# Phase A Data Model (draft for review)

> **Status:** **approved 2026-10-16** (PLAN.md D20). Nothing is built.
> **Scope:** the tables Phase A needs: tenancy, staff and login, devices, roles and permissions, settings, alerts and the audit log. Catalog, sales, stock, payments and Dube come in Phases B–D and follow the same conventions (§1).
> **Notation:** columns are written as `name type`. This is a design, not Drizzle code.

---

## 0. Approved choices

| # | Choice | Why |
|---|---|---|
| M1 | **Staff are not auth users.** A `staff` row is one person in one shop. It *may* link to a login account. Cashiers can be **PIN-only**, with no email or phone account. | This matches how Neil Lewz works today (kiosk PIN sessions). Many cashiers have no email, and SMS OTP costs money per login. |
| M2 | **PIN login works only on a paired device.** The owner pairs a phone or tablet by scanning a one-time QR code (10 min) from their own logged-in phone. The device then holds a long-lived device token. | A 6-digit PIN is weak on its own. Requiring a paired device means a stranger on the internet can't try PINs. Lost device = revoke it in one tap. |
| M3 | **One active tenant per request, set by the server.** The browser never talks to Postgres or the Supabase Data API for business data. The server sets the tenant, staff, session and device inside the transaction, and RLS checks `tenant_id` against it. | This works the same for owners (auth account), cashiers (PIN only), the bot and the console. It also works on plain Postgres, as D13 requires. RLS reads only values the server set, never anything a user can edit. |
| M4 | **Composite foreign keys `(tenant_id, id)`.** Every reference between tenant tables includes `tenant_id`. | The database itself makes it impossible for a shop's sale to point at another shop's product or role, even if app code has a bug. |
| M5 | **Permission keys live in code** (`packages/core`). The database stores only which role holds which key. | One list of keys, type-checked. A CI test checks that every key in the database exists in code. |
| M6 | **Money is `bigint` santim** (1 ETB = 100 santim). Quantities are `numeric(14,3)` (kg, litres). | No floating-point errors. All money math goes through `packages/core`. |
| M7 | **One audit hash chain per tenant**, covering both row changes and events (logins, failed PINs, exports). | One chain is simpler to verify and to anchor nightly. |
| M8 | **Tenant data is never hard-deleted by the app.** Rows are archived (`archived_at`). Closing a tenant = status `closed` + export. Deletion is a console job after the retention period. | Tax retention is 10 years (§6.1). Kippa's users lost their data (RESEARCH §3). |
| M9 | **PINs are 6 digits**, hashed with a server pepper (HMAC) then PBKDF2-SHA256 via WebCrypto, so it runs on Workers. After 5 failures the staff member *and* the device are locked for 15 minutes and a Suspicion alert is raised. PIN hashes never leave the server (D18). | Matches the theft-control pitch. WebCrypto avoids a heavy argon2 WASM bundle on Workers. |

**M3 refinement (D26, 2026-10-16):** the shop app does not connect as the database owner. It logs in as `retail_app`, a role with no `BYPASSRLS`, no inherited privileges and no access until `db.rls()` switches to `authenticated`. This turns "forgot the wrapper" from a silent data leak into an immediate permission error. Migrations, scripts and `db.admin` use the owner login (`DATABASE_ADMIN_URL`), which the web app never receives. Known limit: anyone who can run arbitrary SQL as `authenticated` could call `set_config('app.tenant_id', ...)`. That is why only server code may run SQL and every query is parameterized (see the threat model comment in migration 0001).

**Lesson from Neil Lewz:** its session secret falls back to the service-role key or `"dev-only-secret"`. Here every secret (session signing, PIN pepper, reference pepper, device token pepper) is separate and **required at boot**. A missing secret stops the app; there is no fallback.

---

## 1. Conventions (all phases)

- **IDs:** UUIDv7, generated on the device for anything created offline. Primary key is `id`; every tenant table also has `unique (tenant_id, id)` so composite FKs can point at it (M4).
- **`tenant_id`:** on every tenant table, `not null`, first column of every index.
- **Time:** `timestamptz` in UTC. Rows created on a device also store `device_at` (the device's clock), because offline sales can arrive hours later. Display is Gregorian by default; the Ethiopian calendar is an option per shop and per user (D23).
- **Money:** `bigint` santim, column names end in `_santim`. Currency is ETB (stored once on the tenant, for the future).
- **Translatable text entered by a shop** (branch names, role names, hero text): `jsonb` `{ "en": "...", "am": "..." }`. At least one language is required; display falls back to the other. UI strings themselves live in `packages/i18n` in both languages (CLAUDE.md rule).
- **Status fields:** Postgres enums, defined in Drizzle.
- **Archiving:** `archived_at timestamptz null`. Lists hide archived rows by default.
- **Columns every tenant table has:** `id`, `tenant_id`, `created_at`, `updated_at`, `created_by` (staff id or null for system). Who changed what in detail is in the audit log, not in extra columns.

### Schemas
| Schema | Contents | Who can reach it |
|---|---|---|
| `platform` | Tenants, plans, modules, setting policies, platform admins, access sessions | `db.admin` only (console, jobs) |
| `app` | All tenant business data | `db.rls` (RLS enforced) |
| `audit` | Hash-chained log and nightly anchors | Inserts by trigger only; reads via `db.rls` (own tenant) or console |
| `private` | Security-definer helpers, rate-limit counters | Never exposed |

The Supabase Data API exposes **none** of these (M3).

---

## 2. How a request gets its identity

| Entry point | Who | How identity is proven | Tenant comes from |
|---|---|---|---|
| Admin web (`app.<domain>`) | Owner, manager | Supabase Auth account (Google, or email/phone + password; no SMS OTP at launch) → their `staff` row in the chosen shop | Shop switcher |
| POS on a paired device | Cashier (or anyone) | Device token cookie + PIN → `staff_sessions` row | The device's tenant and branch |
| Telegram bot (Phase D) | Linked staff | `telegram_user_id` → `staff` row | `/switch` |
| Sync API `/api/sync/v1` (Phase F) | Device session | Same as POS | Device |
| Console (`console.<domain>`) | Platform admin | Separate auth + 2FA | Uses `db.admin`. Writes inside a tenant only through an access session (§3.1), with `impersonator_id` recorded |
| Cron / queue jobs | System | Runs on the server | `db.admin`, `actor_kind = system` |

**`db.rls(ctx, tx => …)` does, in one transaction:**
1. `set local role authenticated`
2. `set_config('app.tenant_id' | 'app.staff_id' | 'app.session_id' | 'app.device_id' | 'app.impersonator_id' | 'app.pin_verification_id', …, true)`
3. Checks that the session is still active and the staff member is `active` in that tenant. If not, it aborts. Suspending a cashier therefore locks them out on their next request, as in Neil Lewz.
4. Runs the caller's queries.

**As built (A7a).** Step 3 is `private.assert_session_active()`, run inside the same transaction as the request, so there is no gap between "checked" and "used". It refuses (SQLSTATE `28000`, `SessionEndedError`) a session that was ended, has expired, belongs to another shop or person, whose staff member is not `active`, or whose shop is `closed`. A `paused` shop still passes (it may read). A request that claims no session (platform and system code) is not checked, and a request that claims a staff id **without** a session id is rejected outright, because it could never be revoked.

**Before a shop is chosen: `db.identity()`.** A person who just signed in with an account has no shop context yet. `db.identity({ authUserId, email }, tx => …)` sets `app.auth_user_id` and `app.auth_email` (from the verified token, never from the browser) and nothing else, so tables show no data; only four deliberately narrow `SECURITY DEFINER` functions do anything: `app.my_shops()` (the shop picker), `app.accept_invite(token_hash)`, `app.start_session(...)` and, inside a shop, `app.end_my_session()`.

**Invitations.** `provisionTenant({ owner })` (or `pnpm tenant:create --owner-email --owner-name`) creates the owner as an `invited` staff row holding only the SHA-256 of a 256-bit random token (the token itself is printed once and never stored; valid 14 days). The person signs in with any account whose **verified** email matches the invited address, follows the link, and `accept_invite` links the account and activates them under a row lock. Every way an invitation can be wrong (unknown, used, expired, wrong email, shop paused or closed) gives the same `InviteInvalidError`, so it cannot be used to probe which tokens exist. Joining a shop you already belong to is the one distinct answer (`AlreadyMemberError`) and rolls back, leaving the invitation pending.

**Ending sessions.** Suspending or archiving a staff member ends their open sessions (trigger `end_sessions_on_inactive`, reason `staff_suspended`), and the per-request check refuses them even before that. Reinstating someone does not revive ended sessions; they sign in again. Signing out ends only that session, and works for a paused shop's people too (`end_my_session` steps out of the read-only rule for its single update).

**Personal data in the audit log.** The log can never be edited, so anything personal written into it could never be erased (PLAN.md §8). `app.staff` therefore records `pin_hash`, `invite_token_hash`, `phone` and `invite_email` as `"[redacted]"`; entries name the person by id, and the current name and phone live in `app.staff` where they can be changed or erased. The security check fails the build if any column named like a secret (`hash`, `token`, `secret`, `password`) is not redacted, or if those four staff columns lose their redaction (a careless re-run of `secure_tenant_table` with defaults would do exactly that).

---

## 3. Tables

### 3.1 `platform` schema

**`platform.tenants`**
`id uuid` · `slug citext unique` (subdomain) · `display_name jsonb` · `legal_name text` · `tin text` · `industry enum(electronics, minimarket, cosmetics, food, other)` · `plan_key text` · `status enum(pilot, trial, active, past_due, paused, closed)` · `timezone text default 'Africa/Addis_Ababa'` · `currency char(3) default 'ETB'` · `created_at` · `paused_at` · `closed_at`

`paused` = read-only access plus export, never deletion (PLAN §7.16).

**As built (A4 and A6):** `slug` is plain `text` with a format check and a list of reserved subdomains (`app`, `console`, `www`, `api`, ...), rather than `citext`, so no extension is needed. `display_name` must be a non-empty JSON object. Shops are never deleted: `tenant_id` foreign keys have no cascade.

**Read-only shops (D29).** A `paused` or `closed` shop can read everything and change nothing. A statement-level trigger, `enforce_writable`, attached to every tenant table by `secure_tenant_table()`, refuses INSERT, UPDATE and DELETE (SQLSTATE `25006`) for a session whose tenant context is such a shop, even for a statement that would touch no rows. It restricts only a shop's own session: platform code with no tenant context (support recovering a shop, billing) is not blocked, and `past_due`, `trial`, `pilot` and `active` shops can write. The security check fails the build if any tenant table lacks the trigger.

**`platform.tenant_modules`**: `tenant_id` · `module_key text` · `enabled bool` · `changed_at` · PK `(tenant_id, module_key)`. The database only checks the key's format (`^[a-z][a-z_]*$`); the list of keys that mean something is the registry in `@retail/core`, so adding a module needs no migration.

**`platform.setting_policies`**: `id` · `tenant_id uuid null` (null = platform default) · `key text` (`group.name`, format-checked) · `state enum(editable, locked, hidden)` · `updated_at`. One row per shop per key, and exactly one platform default per key (`UNIQUE NULLS NOT DISTINCT`: a NULL tenant does not count as "different"). Lookup order: tenant row → platform row → default in the code registry. (`updated_by` returns when staff exist, A7.)

**What a shop may know about itself.** `platform` is closed to every tenant-facing role. A shop's session reads its own details through two `SECURITY DEFINER` functions that return only the row of the tenant in the request context: `app.my_tenant()` (id, slug, name, status, industry, plan, timezone, currency; deliberately not the legal name or tax id) and `app.my_modules()` (enabled module keys). Wrappers: `getMyTenant()` and `getEnabledModules()` in `@retail/db`.

**`platform.platform_admins`**: `id` · `auth_user_id unique` · `name` · `role enum(owner, support, onboarder)` · `status` · `created_at`. 2FA is always required.

**`platform.tenant_access_sessions`** (break-glass and onboarding in one table)
`id` · `platform_admin_id` · `tenant_id` · `kind enum(break_glass_read, break_glass_write, onboarding)` · `reason text not null` · `started_at` · `expires_at` (default 1h; onboarding up to 1 day) · `write_confirmed_at` · `ended_at` · `tenant_notified_at`

- `onboarding` (D15) can touch catalog tables only. It is enforced by the permission resolver, which gives an onboarder only `catalog:*` keys.
- While any session is open, the tenant UI shows a banner.

### 3.2 `app` schema: tenant core

**`app.branches`**: `id` · `tenant_id` · `name jsonb` · `address text` · `phone text` · `is_default bool` · `archived_at`. Every tenant gets one default branch at creation. As built: the name must be a non-empty JSON object (one language is enough); a partial unique index allows at most one default branch per shop; and a check forbids archiving the default branch, so a shop always has somewhere to sell.

**Creating a shop** (`pnpm tenant:create`, `provisionTenant()` in `@retail/db/admin`): one transaction that writes the shop, its modules (the starter set for its industry unless a list is given), its default branch and a `tenant.created` audit event, so a shop exists completely or not at all. Since A7a it also creates the five system roles and, with `--owner-email`, the owner's invitation (see §2). What each role may *do* is added in A9.

**`app.staff`**
| Column | Type | Notes |
|---|---|---|
| `id`, `tenant_id` | uuid | |
| `auth_user_id` | uuid null | Set for people who log in with an account. `unique (tenant_id, auth_user_id)` |
| `display_name` | text | |
| `phone` | text null | Masked in the bot and in exports |
| `role_id` | uuid | Composite FK `(tenant_id, role_id)` → `roles` |
| `branch_ids` | uuid[] null | Null = all branches |
| `pin_hash` | text null | M9. Null = no PIN set yet |
| `pin_set_at`, `pin_failed_count`, `pin_locked_until` | | |
| `status` | enum(invited, active, suspended, archived) | As built: an `invited` person has a complete invitation and no account yet; nobody else holds an invitation token (database checks) |
| `invite_email`, `invite_token_hash`, `invite_expires_at` | text, text, timestamptz | **Added in A7a.** The invitation to sign in with an account. Email is lowercase; only the token's SHA-256 is stored; the hash is unique across ALL shops because it is looked up without knowing the shop. Cleared when accepted |
| `preferred_calendar` | enum(gregorian, ethiopian) null | Null = follow the shop's setting (Gregorian unless changed, D23) |
| `preferred_language` | text null | Null = follow the shop's default language (English unless changed, D22). Must be a locale that has a message file |
| `theme` | enum(system, light, dark) | |

**`app.roles`**: `id` · `tenant_id` · `key text` · `name jsonb` · `is_system bool` · `template_key text null` · `archived_at` · `unique (tenant_id, key)`. Each new tenant gets copies of the system templates: Owner, Manager, Cashier, Stock clerk, Viewer. While "Staff & roles" is locked (D7), only the console can change system roles.

**`app.role_permissions`**: `id` · `tenant_id` · `role_id` · `permission_key text` · `unique (tenant_id, role_id, permission_key)`; keys look like `resource:action`; a composite key means a role's permissions can only point at a role of the SAME shop. Filled and enforced by the resolver in A9.

**`app.staff_permission_overrides`**: `tenant_id` · `staff_id` · `permission_key` · `effect enum(allow, deny)` · `reason text not null` · `granted_by` · `created_at`

**As built (A9).** Migrations 0009 (the table) and 0010 (functions and guards). `app.staff_permission_overrides` as above, plus `granted_by`, a non-empty reason, one row per person and key, and a key-format check. `role_permissions` is filled from the core templates when a shop is created (the Owner has no rows: it holds everything by rule). `private.has_permission(tenant, staff, key)` is the database's copy of the resolver (deny, then allow, then owner, then role keys; inactive staff hold nothing; malformed keys are never held). Functions: `app.create_staff`, `set_staff_role`, `set_role_permission`, `set_override`, `remove_override`. Guards: direct writes by the shop's own login to `roles`, `role_permissions`, `staff_permission_overrides`, new `staff` rows and `staff.role_id` are refused; the last owner trigger and the owner-role trigger. See PLAN D33.

**`app.devices`**: `id` · `tenant_id` · `branch_id` · `name text` ("Counter 1") · `kind enum(pos, phone, tablet, desktop)` · `token_hash text` · `paired_by` · `paired_at` · `last_seen_at` · `user_agent` · `revoked_at` · `revoked_by`

**`app.device_pairing_codes`**: `id` · `tenant_id` · `branch_id` · `code_hash` · `created_by` · `expires_at` (10 min) · `used_at` · `used_by_device_id`. The code is single-use.

**As built (A7b).** The web layer (`apps/web/lib/auth`) verifies the login token, calls `app.my_shops`, `accept_invite`, `start_session`, `end_my_session`, and keeps the session in a signed cookie holding only the staff, session and shop ids; the database re-checks the session on every request (§2).

**As built (A8).** Migrations 0007 (tables) and 0008 (functions). `app.devices`, `device_pairing_codes` and `pin_verifications` as above, plus `pin_failed_count` / `pin_locked_until` on devices; `staff_sessions.device_id` is now a real composite foreign key and a `pin` session must have a device. Token and code hashes are globally unique (looked up without knowing the shop) and recorded in the audit log as "[redacted]". Guard triggers: a device's token never changes, a revoked device stays revoked, a PIN approval can only be marked used, once. `private.rate_limits` holds guess counters (no role can read it). Functions (all `SECURITY DEFINER`, fixed search path): `app.create_pairing_code`, `pair_device`, `revoke_device`, `unlock_device`, `device_info`, `device_staff`, `pin_attempt_begin`, `pin_sign_in_finish`, `set_staff_pin`, `step_up_begin`, `step_up_finish`, `consume_step_up`. Functions that count a failure return a status instead of raising. `db.device()` is the third entry point (no shop, no account) next to `db.rls()` and `db.identity()`. The session cookie may carry a device id. See PLAN D32.

**`app.staff_sessions`**: `id` · `tenant_id` · `staff_id` · `device_id null` · `method enum(pin, password, google, telegram)` · `started_at` · `expires_at` (POS 12h, as in Neil Lewz) · `ended_at` · `ended_reason enum(logout, expired, revoked, staff_suspended, device_revoked)`. Sessions live in the database so revoking them takes effect immediately. As built (A7a): a session is either open (no end, no reason) or closed with a reason, never half of each; it must expire after it starts; admin sign-ins last 7 days and till sign-ins 12 hours (`SESSION_HOURS` in core). `device_id` has no foreign key until the devices table exists (A8).

**`app.pin_verifications`** (step-up proof)
`id` · `tenant_id` · `staff_id` (whose PIN was entered) · `requested_by` (staff session that asked) · `device_id` · `action_key` (e.g. `sale:below_floor`) · `entity_id null` · `verified_at` · `expires_at` (2 min) · `consumed_at`

- A PIN check gives a **single-use token bound to one action** and, where it applies, one record. The action consumes the token. The audit log stores `pin_verification_id`, which answers "whose PIN approved this?" in a dispute.
- A cashier asking a manager to enter their PIN on the cashier's device is recorded exactly that way: `requested_by` = cashier, `staff_id` = manager.

**`app.tenant_settings`**: `tenant_id` · `key text` · `value jsonb` · `updated_by` · `updated_at` · PK `(tenant_id, key)`
- **Change from PLAN §4:** `group`, `type`, `is_public` and the default value live in the **settings registry in `packages/core`**, not in each row. This avoids drift. The registry also says whether a key is sensitive (PIN prompt on save).
- Values are validated with the key's Zod schema on save.
- The cache tag is `settings:<tenant>`, cleared on save.

**`app.alerts`** (in Phase A because PIN lockouts and failed logins already raise alerts)
`id` · `tenant_id` · `branch_id null` · `category enum(fraud, suspicion, error, alert, message, info)` · `rule_key text` · `severity smallint` · `entity_type text null` · `entity_id uuid null` · `payload jsonb` · `status enum(new, ack, resolved, dismissed)` · `assignee_staff_id null` · `resolution_note text null` · `resolved_by` · `resolved_at`. Index `(tenant_id, status, category, created_at desc)`.

### 3.3 `audit` schema

**`audit.log`**
| Column | Notes |
|---|---|
| `tenant_id`, `seq bigint` | PK `(tenant_id, seq)`. `seq` has no gaps within a tenant |
| `occurred_at` | Server time |
| `device_at` | Device time, if the change came from a device |
| `event_key` | `row.insert`, `row.update`, `row.delete`, or an event such as `auth.pin_failed`, `export.downloaded`, `settings.changed` |
| `actor_kind` | staff, platform_admin, system, bot, customer |
| `actor_id`, `impersonator_id`, `session_id`, `device_id`, `pin_verification_id` | From the request context (§2) |
| `table_name`, `row_id` | For row events |
| `before_data`, `after_data` | jsonb (named this way rather than `before`/`after`, which are SQL keywords). Insert: whole row in `after_data`. Delete: whole row in `before_data`. Update: only the columns that changed |
| `txid` | |
| `prev_hash`, `hash` | `hash = sha256(prev_hash ‖ canonical(entry))`. The first entry's `prev_hash` is a per-tenant genesis hash, so one tenant's chain cannot be spliced into another's |

**As built (migration 0002, task A5):**
- **Writing:** an `audit_row` trigger (AFTER, per row) on every `app` table, attached by `private.secure_tenant_table()` so it cannot be forgotten. The trigger function and `audit.append()` run as the owner (`SECURITY DEFINER`, fixed `search_path`), because no tenant role may insert into the log. Non-row events (`auth.pin_failed`, `export.downloaded`, `settings.changed`) go through `audit.record_event(key, data)`, which always writes into the *current* tenant's chain and refuses `row.*` keys. Platform code uses the owner-only `audit.record_event_for(tenant, ...)`.
- **Ordering:** each append takes a per-tenant `pg_advisory_xact_lock`, so `seq` is gapless and in commit order. A rolled-back transaction leaves no entry and no gap. Because that lock is otherwise first taken at the first audited write, two writers touching the same rows in opposite orders can deadlock; `db.rls(ctx, fn, { write: true })` takes the lock first and removes the hazard (tested both ways).
- **Per-table options:** `secure_tenant_table(table, p_ignore, p_redact)`. *Ignored* columns: a change to only those is not recorded (`updated_at` is always ignored). *Redacted* columns (`pin_hash`, token hashes): recorded as `"[redacted]"`, so the log shows that a PIN changed but never its value. A column name that does not exist is an error, so a typo cannot silently audit the wrong thing.
- **Actor:** an impersonating platform admin is recorded as `platform_admin`; otherwise a staff member as `staff`; with no request context, `system`. `bot` and `customer` need new context settings and arrive with those features.
- **Write-once:** UPDATE, DELETE and TRUNCATE are revoked **even from the owner**, and triggers refuse them as well. A rogue administrator can still force it (re-grant, disable the trigger); the hash chain then shows exactly where, and the anchors show a rewrite or truncated tail.
- **Hashing:** canonical text = a `jsonb` object of the entry's fields (jsonb prints keys in one fixed order), timestamps as whole microseconds since the epoch. A test pins a known input to a known hash and recomputes it with an independent SHA-256, so any change to the definition (or to how a future Postgres prints jsonb) fails loudly instead of silently invalidating every chain. `audit.verify_chain(tenant)` in SQL is the reference verifier.
- **Reading:** a tenant session may `SELECT` only its own entries (RLS policy `tenant_read`; RLS is enabled but not forced, so the owner's definer functions can insert) and call `verify_own_chain()`. Who may *look* (`audit:view`) is decided by the permission resolver, not RLS.
- **Not covered by a chain:** the newest entries being deleted. That is what anchors are for.

**`audit.anchors`**: `tenant_id` · `seq` · `hash` · `anchored_at` · `object_key` (owner-only, also append-only). A nightly job copies each tenant's chain head to an object store and records it here; `audit.verify_anchors(tenant)` compares every anchor with the log and reports "entries removed" or "history rewritten". The job refuses to anchor a chain that does not verify.

### 3.4 `private` schema
- `private.ctx_tenant()`, `ctx_staff()`, `ctx_session()`: read the values `db.rls` set. They return null if a value is missing, so a query with no context sees **no rows** (fails closed).
- Rate-limit counters (PIN attempts per device, pairing attempts).

---

## 4. RLS template

Applied to every `app` table, and generated from one Drizzle helper so no table can be missed:

```sql
alter table app.<t> enable row level security;
alter table app.<t> force row level security;
create policy tenant_isolation on app.<t> for all to authenticated
  using      (tenant_id = (select private.ctx_tenant()))
  with check (tenant_id = (select private.ctx_tenant()));
```

- **RLS only isolates tenants.** Permissions (who may change prices) are checked by the one resolver in `packages/core`. Branch scoping is also enforced in the resolver and in queries, not in RLS.
- A CI check fails the build if any `app` table lacks RLS, `force`, the policy, the audit trigger, or a leak test.

---

## 5. Permissions in Phase A

**Keys:**
- `tenant:manage`
- `staff:view`, `staff:invite`, `staff:edit`, `staff:suspend`
- `role:assign`
- `device:pair`, `device:revoke`
- `settings:view`, `settings:edit`
- `audit:view`
- `alert:view`, `alert:resolve`
- `export:download`

Later modules add their own keys (`product:edit_price`, `sale:below_floor`, …).

**Resolver:**

`effective = (keys of the role ∪ allow overrides) − deny overrides`

The resolver then keeps only keys whose module is enabled for the tenant. The Owner role holds every key of every enabled module.

**Rules from PLAN §5, and where each is enforced:**
| Rule | Enforced in |
|---|---|
| Roles are never read from `user_metadata` | Resolver reads only `staff`, `roles` and overrides |
| You can only grant keys you hold | Resolver (`role:assign`, overrides) |
| You can't edit your own permissions | Resolver |
| The last active Owner can't be removed, suspended or demoted | **Database constraint trigger** on `staff`, so a bug can't bypass it |
| Deny overrides really remove a key | Resolver + unit tests |
| Every role or permission change is audited | Audit trigger on `roles`, `role_permissions`, `staff`, overrides |

---

## 6. Tests Phase A must ship with

- **pgTAP leak test per `app` table:**
  - with tenant A's context, tenant B's rows are invisible
  - inserts with B's `tenant_id` fail
  - a composite FK to B's row fails
  - no context = no rows
- **Audit tests:**
  - the chain verifies
  - tampering with one row breaks verification
  - UPDATE/DELETE on `audit.log` fail
- **Unit tests** (`packages/core`):
  - the permission resolver, including denies, grant limits and editing yourself
  - PIN hashing and lockout
  - the settings registry and Zod schemas
- **Last-owner trigger tests.**
- **Boot test:** the app refuses to start when any required secret is missing.

---

## 7. Phase B+ preview (same conventions)

`customers` (phone-first) · `products`, `product_variants`, `price_tiers`, `product_images`, `price_history` · `sales`, `sale_lines` (stores `list_price_santim`, `charged_price_santim`, `price_source`, `floor_at_sale_santim`, `discount_id`) · `payments`, `payment_references` (unique per tenant) · `stock_movements` (append-only), `stock_lots`, `stock_counts` · `serial_units` · `shifts`, `shift_counts` · `invoice_sequences` (sequential numbers per branch, ready for e-invoicing).

Designed in [DATA_MODEL_B.md](DATA_MODEL_B.md).
