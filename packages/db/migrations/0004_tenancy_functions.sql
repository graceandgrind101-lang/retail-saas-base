-- 0004_tenancy_functions (hand-written; Phase A task A6, docs/DATA_MODEL.md §3.1-3.2)
--
--   * app.my_modules() and app.my_tenant(): the ONLY way a shop's session reads anything about
--     itself from `platform`, which is otherwise closed to every tenant-facing role.
--   * Read-only shops: a paused or closed shop can still READ everything but can no longer
--     change anything (PLAN.md §7.16: "pause access when unpaid, never delete"), enforced by a
--     trigger on every tenant table, so it cannot depend on application code remembering.
--   * private.secure_tenant_table() now attaches that trigger too, and every existing tenant
--     table (app.branches) is brought up to date.
--
-- Rules for this file (see migration 0001): statements are separated by Drizzle's breakpoint
-- marker, which must never appear inside a comment or a string.

-- ── What a shop may know about itself ───────────────────────────────────────
-- SECURITY DEFINER because `platform` is closed to shops; they get exactly these rows and
-- columns, for the tenant named by the request context and no other. The legal name and tax
-- id are deliberately not here: they belong to the editable business profile (task A14).
CREATE FUNCTION app.my_modules() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT m.module_key
  FROM platform.tenant_modules m
  WHERE m.tenant_id = private.ctx_tenant() AND m.enabled
  ORDER BY m.module_key
$$;
--> statement-breakpoint
CREATE FUNCTION app.my_tenant()
RETURNS TABLE (
  id uuid, slug text, display_name jsonb, status text, industry text,
  plan_key text, timezone text, currency text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT t.id, t.slug, t.display_name, t.status::text, t.industry::text,
         t.plan_key, t.timezone, t.currency::text
  FROM platform.tenants t
  WHERE t.id = private.ctx_tenant()
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.my_modules(), app.my_tenant() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.my_modules(), app.my_tenant() TO authenticated;
--> statement-breakpoint

-- ── Paused and closed shops are read-only ───────────────────────────────────
-- Fires once per statement, before any row is touched. It only restricts a SHOP's own session
-- (one with a tenant context); platform code with no context (the console, billing, support
-- recovering a shop) is not blocked. SQLSTATE 25006 (read_only_sql_transaction) is what the
-- app maps to "your account is paused".
CREATE FUNCTION private.assert_tenant_writable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant uuid := private.ctx_tenant();
  v_status text;
BEGIN
  IF v_tenant IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT t.status::text INTO v_status FROM platform.tenants t WHERE t.id = v_tenant;
  IF v_status IN ('paused', 'closed') THEN
    RAISE EXCEPTION 'this shop is % and read-only', v_status USING ERRCODE = 'read_only_sql_transaction';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.assert_tenant_writable() FROM PUBLIC;
--> statement-breakpoint

-- ── Securing a tenant table, version 3 ──────────────────────────────────────
-- Same as migration 0002's version, plus the read-only trigger. Replaces the function in place.
CREATE OR REPLACE FUNCTION private.secure_tenant_table(
  p_table regclass,
  p_ignore text[] DEFAULT ARRAY[]::text[],
  p_redact text[] DEFAULT ARRAY[]::text[]
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_schema name;
  v_name   name;
  v_col    text;
  v_args   text[] := ARRAY[]::text[];
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

  -- A typo in a column list would silently audit more or less than intended.
  FOREACH v_col IN ARRAY p_ignore || p_redact LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = p_table AND attname = v_col AND NOT attisdropped) THEN
      RAISE EXCEPTION 'secure_tenant_table: % has no column %', p_table, v_col;
    END IF;
  END LOOP;
  FOREACH v_col IN ARRAY p_ignore LOOP v_args := v_args || quote_literal('ignore:' || v_col); END LOOP;
  FOREACH v_col IN ARRAY p_redact LOOP v_args := v_args || quote_literal('redact:' || v_col); END LOOP;

  EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', v_schema, v_name);
  EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', v_schema, v_name);

  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I.%I', v_schema, v_name);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %I.%I AS PERMISSIVE FOR ALL TO authenticated '
    'USING (tenant_id = (SELECT private.ctx_tenant())) '
    'WITH CHECK (tenant_id = (SELECT private.ctx_tenant()))',
    v_schema, v_name);

  EXECUTE format('REVOKE ALL ON %I.%I FROM PUBLIC, anon, authenticated, service_role, retail_app', v_schema, v_name);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO authenticated', v_schema, v_name);

  -- BEFORE, once per statement: refuse changes from a paused or closed shop's session.
  EXECUTE format('DROP TRIGGER IF EXISTS enforce_writable ON %I.%I', v_schema, v_name);
  EXECUTE format(
    'CREATE TRIGGER enforce_writable BEFORE INSERT OR UPDATE OR DELETE ON %I.%I '
    'FOR EACH STATEMENT EXECUTE FUNCTION private.assert_tenant_writable()',
    v_schema, v_name);

  EXECUTE format('DROP TRIGGER IF EXISTS touch_updated_at ON %I.%I', v_schema, v_name);
  EXECUTE format(
    'CREATE TRIGGER touch_updated_at BEFORE UPDATE ON %I.%I '
    'FOR EACH ROW EXECUTE FUNCTION private.touch_updated_at()',
    v_schema, v_name);

  -- AFTER, so the audit entry sees the row exactly as it was stored.
  EXECUTE format('DROP TRIGGER IF EXISTS audit_row ON %I.%I', v_schema, v_name);
  EXECUTE format(
    'CREATE TRIGGER audit_row AFTER INSERT OR UPDATE OR DELETE ON %I.%I '
    'FOR EACH ROW EXECUTE FUNCTION audit.record_row_change(%s)',
    v_schema, v_name, array_to_string(v_args, ', '));
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.secure_tenant_table(regclass, text[], text[]) FROM PUBLIC;
--> statement-breakpoint
-- Bring every existing tenant table up to date, including the new app.branches.
-- (Tables with custom ignore/redact lists must re-pass them: none exist yet.)
DO $$
DECLARE
  t regclass;
BEGIN
  FOR t IN
    SELECT c.oid::regclass FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p')
  LOOP
    PERFORM private.secure_tenant_table(t);
  END LOOP;
END
$$;
