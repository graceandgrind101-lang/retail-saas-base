-- 0001_foundation (hand-written; Phase A task A4, docs/DATA_MODEL.md §2 and §4)
--
-- Everything Drizzle cannot express: roles, grants, the request-context functions and the
-- function that secures a tenant table. Statements are separated by Drizzle's breakpoint
-- marker (a comment starting with two dashes and a greater-than sign) because the runner
-- executes one statement at a time. Never write that marker inside a comment or string.
--
-- Threat model for the context settings (app.tenant_id, ...): only server code runs SQL.
-- The browser never reaches Postgres or the Supabase Data API (DATA_MODEL M3), and server
-- code sets the settings only inside `db.rls()`. The login the shop app uses (`retail_app`)
-- has NO bypass of row-level security and NO privileges until a request has switched to
-- `authenticated`, so code that forgets the wrapper gets a loud permission error, not data.

-- ── Roles ───────────────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Supabase already has these three. Plain Postgres (a later move off Supabase, PLAN.md D13) does not.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
  -- The login for the shop app. Created without a password and without LOGIN; the migrate
  -- script enables it from APP_DB_PASSWORD, so no credential ever lives in a migration.
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'retail_app') THEN
    CREATE ROLE retail_app NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
-- NOINHERIT is the one default we change: without it retail_app would silently hold
-- authenticated's rights, and code that forgot db.rls() would see empty results instead of
-- failing loudly. A new role is already NOSUPERUSER, NOBYPASSRLS, NOCREATEDB and NOCREATEROLE,
-- and a non-superuser migration role may not even name those attributes in ALTER ROLE
-- (PostgreSQL 16+), so they are asserted by the security check instead
-- (packages/db/src/ci/security-check.ts), which runs in CI and in the test suite.
ALTER ROLE retail_app NOINHERIT;
--> statement-breakpoint
GRANT authenticated TO retail_app;
--> statement-breakpoint

-- ── Schemas and lockdown ────────────────────────────────────────────────────
-- `platform` and `app` were created by migration 0000.
CREATE SCHEMA IF NOT EXISTS audit;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS private;
--> statement-breakpoint
COMMENT ON SCHEMA platform IS 'Shops, plans, platform admins. db.admin only: no tenant-facing role has any privilege here.';
--> statement-breakpoint
COMMENT ON SCHEMA app IS 'Tenant business data. Every table has tenant_id and forced row-level security (private.secure_tenant_table).';
--> statement-breakpoint
COMMENT ON SCHEMA audit IS 'Hash-chained, append-only audit log (task A5).';
--> statement-breakpoint
COMMENT ON SCHEMA private IS 'Helpers: request-context functions, tenant-table securing. Not exposed.';
--> statement-breakpoint
REVOKE ALL ON SCHEMA platform, app, audit, private FROM PUBLIC, anon, authenticated, service_role, retail_app;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA platform FROM PUBLIC, anon, authenticated, service_role, retail_app;
--> statement-breakpoint
GRANT USAGE ON SCHEMA app TO authenticated;
--> statement-breakpoint
GRANT USAGE ON SCHEMA private TO authenticated;
--> statement-breakpoint

-- ── Request context ─────────────────────────────────────────────────────────
-- `db.rls()` sets these with set_config(..., true) inside a transaction. A missing,
-- empty or malformed value reads as NULL, which makes every policy false: no context, no rows.
CREATE OR REPLACE FUNCTION private.ctx_uuid(setting text) RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN s ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN s::uuid
  END
  FROM (SELECT NULLIF(current_setting(setting, true), '') AS s) AS t
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.ctx_tenant() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$ SELECT private.ctx_uuid('app.tenant_id') $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.ctx_staff() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$ SELECT private.ctx_uuid('app.staff_id') $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.ctx_session() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$ SELECT private.ctx_uuid('app.session_id') $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.ctx_device() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$ SELECT private.ctx_uuid('app.device_id') $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.ctx_impersonator() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$ SELECT private.ctx_uuid('app.impersonator_id') $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION private.ctx_pin_verification() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$ SELECT private.ctx_uuid('app.pin_verification_id') $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  private.ctx_uuid(text), private.ctx_tenant(), private.ctx_staff(), private.ctx_session(),
  private.ctx_device(), private.ctx_impersonator(), private.ctx_pin_verification()
FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  private.ctx_uuid(text), private.ctx_tenant(), private.ctx_staff(), private.ctx_session(),
  private.ctx_device(), private.ctx_impersonator(), private.ctx_pin_verification()
TO authenticated;
--> statement-breakpoint

-- ── Standard tenant-table trigger ───────────────────────────────────────────
-- Keeps updated_at honest and makes identity columns immutable. Row-level security already
-- stops a row from moving to another tenant; this is a second lock that also covers admin mistakes.
CREATE OR REPLACE FUNCTION private.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'id cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'tenant_id cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'created_at cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.touch_updated_at() FROM PUBLIC;
--> statement-breakpoint

-- ── Securing a tenant table ─────────────────────────────────────────────────
-- Every table in `app` must be passed through this in its migration. It is idempotent.
-- The CI check (packages/db: check:tenant-tables) fails the build if any `app` table was missed.
CREATE OR REPLACE FUNCTION private.secure_tenant_table(p_table regclass) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_schema name;
  v_name   name;
BEGIN
  SELECT n.nspname, c.relname INTO v_schema, v_name
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.oid = p_table;

  IF v_schema IS DISTINCT FROM 'app' THEN
    RAISE EXCEPTION 'secure_tenant_table: % is not in schema app', p_table;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = p_table AND attname = 'tenant_id' AND attnotnull AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'secure_tenant_table: % has no NOT NULL tenant_id column', p_table;
  END IF;

  EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', v_schema, v_name);
  EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', v_schema, v_name);

  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I.%I', v_schema, v_name);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %I.%I AS PERMISSIVE FOR ALL TO authenticated '
    'USING (tenant_id = (SELECT private.ctx_tenant())) '
    'WITH CHECK (tenant_id = (SELECT private.ctx_tenant()))',
    v_schema, v_name);

  -- Explicit grants: nothing is inherited from Supabase default privileges.
  EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC, anon, authenticated, service_role, retail_app', v_schema, v_name);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO authenticated', v_schema, v_name);

  EXECUTE format('DROP TRIGGER IF EXISTS touch_updated_at ON %I.%I', v_schema, v_name);
  EXECUTE format(
    'CREATE TRIGGER touch_updated_at BEFORE UPDATE ON %I.%I '
    'FOR EACH ROW EXECUTE FUNCTION private.touch_updated_at()',
    v_schema, v_name);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.secure_tenant_table(regclass) FROM PUBLIC;
