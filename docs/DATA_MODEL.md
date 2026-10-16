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

---

## 3. Tables

### 3.1 `platform` schema

**`platform.tenants`**
`id uuid` · `slug citext unique` (subdomain) · `display_name jsonb` · `legal_name text` · `tin text` · `industry enum(electronics, minimarket, cosmetics, food, other)` · `plan_key text` · `status enum(pilot, trial, active, past_due, paused, closed)` · `timezone text default 'Africa/Addis_Ababa'` · `currency char(3) default 'ETB'` · `created_at` · `paused_at` · `closed_at`

`paused` = read-only access plus export, never deletion (PLAN §7.16).

**`platform.tenant_modules`**: `tenant_id` · `module_key text` (pos, inventory, payments, dube, …) · `enabled bool` · `changed_at` · PK `(tenant_id, module_key)`

**`platform.setting_policies`**: `tenant_id uuid null` (null = platform default) · `key text` · `state enum(editable, locked, hidden)` · `updated_by` · `updated_at`. Lookup order: tenant row → platform row → default in the code registry.

**`platform.platform_admins`**: `id` · `auth_user_id unique` · `name` · `role enum(owner, support, onboarder)` · `status` · `created_at`. 2FA is always required.

**`platform.tenant_access_sessions`** (break-glass and onboarding in one table)
`id` · `platform_admin_id` · `tenant_id` · `kind enum(break_glass_read, break_glass_write, onboarding)` · `reason text not null` · `started_at` · `expires_at` (default 1h; onboarding up to 1 day) · `write_confirmed_at` · `ended_at` · `tenant_notified_at`

- `onboarding` (D15) can touch catalog tables only. It is enforced by the permission resolver, which gives an onboarder only `catalog:*` keys.
- While any session is open, the tenant UI shows a banner.

### 3.2 `app` schema: tenant core

**`app.branches`**: `id` · `tenant_id` · `name jsonb` · `address text` · `phone text` · `is_default bool` · `archived_at`. Every tenant gets one default branch at creation.

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
| `status` | enum(invited, active, suspended, archived) | |
| `preferred_calendar` | enum(gregorian, ethiopian) null | Null = follow the shop's setting (Gregorian unless changed, D23) |
| `preferred_language` | text null | Null = follow the shop's default language (English unless changed, D22). Must be a locale that has a message file |
| `theme` | enum(system, light, dark) | |

**`app.roles`**: `id` · `tenant_id` · `key text` · `name jsonb` · `is_system bool` · `template_key text null` · `archived_at` · `unique (tenant_id, key)`. Each new tenant gets copies of the system templates: Owner, Manager, Cashier, Stock clerk, Viewer. While "Staff & roles" is locked (D7), only the console can change system roles.

**`app.role_permissions`**: `tenant_id` · `role_id` · `permission_key text` · PK `(role_id, permission_key)`

**`app.staff_permission_overrides`**: `tenant_id` · `staff_id` · `permission_key` · `effect enum(allow, deny)` · `reason text not null` · `granted_by` · `created_at`

**`app.devices`**: `id` · `tenant_id` · `branch_id` · `name text` ("Counter 1") · `kind enum(pos, phone, tablet, desktop)` · `token_hash text` · `paired_by` · `paired_at` · `last_seen_at` · `user_agent` · `revoked_at` · `revoked_by`

**`app.device_pairing_codes`**: `id` · `tenant_id` · `branch_id` · `code_hash` · `created_by` · `expires_at` (10 min) · `used_at` · `used_by_device_id`. The code is single-use.

**`app.staff_sessions`**: `id` · `tenant_id` · `staff_id` · `device_id null` · `method enum(pin, password, google, telegram)` · `started_at` · `expires_at` (POS 12h, as in Neil Lewz) · `ended_at` · `ended_reason enum(logout, expired, revoked, staff_suspended, device_revoked)`. Sessions live in the database so revoking them takes effect immediately.

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
| `before`, `after` | jsonb. For updates, changed columns only |
| `txid` | |
| `prev_hash`, `hash` | `hash = sha256(prev_hash ‖ canonical(row))` |

- **Writing:** a trigger on every `app` table, plus `audit.record_event(...)` for non-row events. Each write takes a per-tenant `pg_advisory_xact_lock`, so `seq` and the hash chain stay in order. That's fine for shop-sized write volumes.
- **Write-once:** UPDATE, DELETE and TRUNCATE are revoked and also blocked by a trigger.
- **Noise:** updates that only touch `last_seen_at`-style columns are skipped (a per-table ignore list).
- **Hashing input:** Postgres `jsonb::text` output is deterministic, so `audit.verify_chain(tenant_id)` in SQL is the reference verifier.

**`audit.anchors`**: `tenant_id` · `seq` · `hash` · `anchored_at` · `object_key`. A nightly job writes each tenant's chain head to R2 with Object Lock.

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
