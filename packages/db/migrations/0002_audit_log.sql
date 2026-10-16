-- 0002_audit_log (hand-written; Phase A task A5, docs/DATA_MODEL.md §3.3)
--
-- A tamper-evident, append-only audit log with one hash chain per tenant.
--
--   * Every row change in `app` is recorded by a trigger (audit_row) that
--     private.secure_tenant_table() attaches, so recording cannot be forgotten.
--   * Each entry's hash covers the previous entry's hash. Editing or removing any entry
--     breaks every hash after it, and audit.verify_chain() finds the first bad entry.
--   * A chain alone cannot reveal that the NEWEST entries were deleted. That is what
--     anchors are for: a job copies the chain head outside the database (audit.anchors plus
--     an object store) and audit.verify_anchors() compares them with the log.
--   * Nobody can UPDATE, DELETE or TRUNCATE: privileges are revoked (even from the owner) and
--     triggers refuse. A rogue DBA can still force it, but the chain then fails to verify.
--
-- Rules for this file (see the note in migration 0001): statements are separated by Drizzle's
-- breakpoint marker, and that marker must never appear inside a comment or a string.

-- ── Tables ──────────────────────────────────────────────────────────────────
CREATE TABLE audit.log (
  tenant_id           uuid        NOT NULL REFERENCES platform.tenants (id),
  -- 1, 2, 3 ... with no gaps, per tenant. Assigned under a per-tenant lock.
  seq                 bigint      NOT NULL CHECK (seq >= 1),
  occurred_at         timestamptz NOT NULL,
  -- the device's own clock, for changes made offline (filled in by Phase F sync)
  device_at           timestamptz,
  event_key           text        NOT NULL CHECK (event_key ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$'),
  actor_kind          text        NOT NULL CHECK (actor_kind IN ('staff', 'platform_admin', 'system', 'bot', 'customer')),
  actor_id            uuid,
  impersonator_id     uuid,
  session_id          uuid,
  device_id           uuid,
  pin_verification_id uuid,
  table_name          text,
  row_id              uuid,
  -- For an update: only the columns that changed, old values in before_data, new in after_data.
  before_data         jsonb,
  after_data          jsonb,
  txid                bigint      NOT NULL,
  prev_hash           text        NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  hash                text        NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (tenant_id, seq)
);
--> statement-breakpoint
CREATE INDEX audit_log_record_idx ON audit.log (tenant_id, table_name, row_id, seq);
--> statement-breakpoint
CREATE INDEX audit_log_time_idx ON audit.log (tenant_id, occurred_at);
--> statement-breakpoint

-- Chain heads copied out of the database. Written by the anchor job (owner only).
CREATE TABLE audit.anchors (
  tenant_id   uuid        NOT NULL REFERENCES platform.tenants (id),
  seq         bigint      NOT NULL CHECK (seq >= 1),
  hash        text        NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  anchored_at timestamptz NOT NULL DEFAULT now(),
  object_key  text        NOT NULL,
  PRIMARY KEY (tenant_id, seq)
);
--> statement-breakpoint

-- ── Hashing (the one definition, used both when writing and when verifying) ──
CREATE FUNCTION audit.genesis_hash(p_tenant uuid) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  -- Tied to the tenant, so one tenant's chain cannot be spliced into another's.
  SELECT encode(sha256(convert_to('retail-audit-genesis:' || p_tenant::text, 'UTF8')), 'hex')
$$;
--> statement-breakpoint
-- Canonical form: a jsonb object (jsonb prints keys in one fixed order), timestamps as whole
-- microseconds since the epoch so no locale or time zone setting can change the text.
-- A test pins a known input to a known hash, so any change here, or in how a future Postgres
-- prints jsonb, is caught instead of silently invalidating every existing chain.
CREATE FUNCTION audit.compute_hash(
  p_prev text, p_tenant uuid, p_seq bigint, p_occurred timestamptz, p_event text,
  p_actor_kind text, p_actor uuid, p_impersonator uuid, p_session uuid, p_device uuid,
  p_pin uuid, p_table text, p_row uuid, p_before jsonb, p_after jsonb, p_txid bigint,
  p_device_at timestamptz
) RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT encode(sha256(convert_to(
    p_prev || '|' || jsonb_build_object(
      'tenant', p_tenant,
      'seq', p_seq,
      'at', (extract(epoch FROM p_occurred) * 1000000)::bigint,
      'device_at', CASE WHEN p_device_at IS NULL THEN NULL ELSE (extract(epoch FROM p_device_at) * 1000000)::bigint END,
      'event', p_event,
      'actor_kind', p_actor_kind,
      'actor', p_actor,
      'impersonator', p_impersonator,
      'session', p_session,
      'device', p_device,
      'pin', p_pin,
      'table', p_table,
      'row', p_row,
      'before', p_before,
      'after', p_after,
      'txid', p_txid
    )::text, 'UTF8')), 'hex')
$$;
--> statement-breakpoint

-- ── Appending ───────────────────────────────────────────────────────────────
-- Internal. Takes the tenant's lock so entries get consecutive numbers in commit order, then
-- chains the new entry onto the previous one. Runs as the owner, because nobody else may
-- insert into audit.log. Callers: audit_row triggers and audit.record_event*.
CREATE FUNCTION audit.append(
  p_tenant uuid, p_event text, p_table text, p_row uuid, p_before jsonb, p_after jsonb
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_seq   bigint;
  v_prev  text;
  v_at    timestamptz := clock_timestamp();
  v_imp   uuid := private.ctx_impersonator();
  v_staff uuid := private.ctx_staff();
  v_kind  text;
  v_actor uuid;
  v_sess  uuid := private.ctx_session();
  v_dev   uuid := private.ctx_device();
  v_pin   uuid := private.ctx_pin_verification();
  v_txid  bigint := txid_current();
BEGIN
  -- Held until this transaction ends. Two writers for one tenant take turns, which is what
  -- keeps seq gapless. (Use READ COMMITTED: the lookup below must see the previous winner.)
  PERFORM pg_advisory_xact_lock(hashtextextended('audit:' || p_tenant::text, 0));

  SELECT l.seq, l.hash INTO v_seq, v_prev
  FROM audit.log l WHERE l.tenant_id = p_tenant ORDER BY l.seq DESC LIMIT 1;
  IF NOT FOUND THEN
    v_seq := 0;
    v_prev := audit.genesis_hash(p_tenant);
  END IF;
  v_seq := v_seq + 1;

  IF v_imp IS NOT NULL THEN
    v_kind := 'platform_admin'; v_actor := v_imp;
  ELSIF v_staff IS NOT NULL THEN
    v_kind := 'staff'; v_actor := v_staff;
  ELSE
    v_kind := 'system'; v_actor := NULL;
  END IF;

  INSERT INTO audit.log (
    tenant_id, seq, occurred_at, event_key, actor_kind, actor_id, impersonator_id, session_id,
    device_id, pin_verification_id, table_name, row_id, before_data, after_data, txid, prev_hash, hash
  ) VALUES (
    p_tenant, v_seq, v_at, p_event, v_kind, v_actor, v_imp, v_sess,
    v_dev, v_pin, p_table, p_row, p_before, p_after, v_txid, v_prev,
    audit.compute_hash(v_prev, p_tenant, v_seq, v_at, p_event, v_kind, v_actor, v_imp, v_sess,
                       v_dev, v_pin, p_table, p_row, p_before, p_after, v_txid, NULL)
  );
  RETURN v_seq;
END
$$;
--> statement-breakpoint

-- ── Recording row changes ───────────────────────────────────────────────────
-- Replace the named columns of a json object with "[redacted]" (so the log shows THAT a PIN
-- hash changed, never its value).
CREATE FUNCTION audit.redact(p_data jsonb, p_columns text[]) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
  c text;
  v jsonb := p_data;
BEGIN
  IF v IS NULL THEN RETURN NULL; END IF;
  FOREACH c IN ARRAY p_columns LOOP
    IF v ? c THEN v := jsonb_set(v, ARRAY[c], '"[redacted]"'::jsonb); END IF;
  END LOOP;
  RETURN v;
END
$$;
--> statement-breakpoint
-- Trigger function for every table in `app`. Per-table options arrive as trigger arguments,
-- 'ignore:<column>' (a change to only such columns is not recorded; updated_at is always
-- ignored) and 'redact:<column>'.
CREATE FUNCTION audit.record_row_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_old    jsonb;
  v_new    jsonb;
  v_before jsonb;
  v_after  jsonb;
  v_ref    jsonb;
  v_ignore text[] := ARRAY[]::text[];
  v_redact text[] := ARRAY[]::text[];
  v_arg    text;
  v_event  text;
BEGIN
  IF TG_NARGS > 0 THEN
    FOREACH v_arg IN ARRAY TG_ARGV LOOP
      IF v_arg LIKE 'ignore:%' THEN v_ignore := v_ignore || substr(v_arg, 8);
      ELSIF v_arg LIKE 'redact:%' THEN v_redact := v_redact || substr(v_arg, 8);
      END IF;
    END LOOP;
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_event := 'row.insert';
    v_new := to_jsonb(NEW);
    v_after := audit.redact(v_new, v_redact);
    v_ref := v_new;
  ELSIF TG_OP = 'DELETE' THEN
    v_event := 'row.delete';
    v_old := to_jsonb(OLD);
    v_before := audit.redact(v_old, v_redact);
    v_ref := v_old;
  ELSE
    v_event := 'row.update';
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    SELECT jsonb_object_agg(k, v_old -> k), jsonb_object_agg(k, v_new -> k)
      INTO v_before, v_after
    FROM jsonb_object_keys(v_new) AS k
    WHERE (v_old -> k) IS DISTINCT FROM (v_new -> k)
      AND k <> 'updated_at'
      AND NOT (k = ANY (v_ignore));
    IF v_after IS NULL THEN
      RETURN NULL; -- nothing but noise changed
    END IF;
    v_before := audit.redact(v_before, v_redact);
    v_after := audit.redact(v_after, v_redact);
    v_ref := v_new;
  END IF;

  PERFORM audit.append(
    (v_ref ->> 'tenant_id')::uuid, v_event, TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
    (v_ref ->> 'id')::uuid, v_before, v_after);
  RETURN NULL;
END
$$;
--> statement-breakpoint

-- ── Recording other events (sign-ins, exports, settings changes, failed PINs ...) ──
-- For code running inside db.rls(): the entry always goes into the CURRENT tenant's chain,
-- so one tenant can never write into another's.
CREATE FUNCTION audit.record_event(p_event text, p_data jsonb DEFAULT NULL) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant uuid := private.ctx_tenant();
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'audit.record_event: no tenant context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_event LIKE 'row.%' THEN
    RAISE EXCEPTION 'audit.record_event: event keys starting with "row." are reserved for row changes'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN audit.append(v_tenant, p_event, NULL, NULL, NULL, p_data);
END
$$;
--> statement-breakpoint
-- For platform code (console, jobs, scripts) acting on a named tenant. Owner only.
CREATE FUNCTION audit.record_event_for(p_tenant uuid, p_event text, p_data jsonb DEFAULT NULL) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_event LIKE 'row.%' THEN
    RAISE EXCEPTION 'audit.record_event_for: event keys starting with "row." are reserved for row changes'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN audit.append(p_tenant, p_event, NULL, NULL, NULL, p_data);
END
$$;
--> statement-breakpoint
-- Take the tenant's audit lock at the START of a write transaction. Without it, two
-- transactions that touch the same rows in opposite orders can deadlock, because the lock is
-- otherwise first taken at the first audited write, after some row locks are already held.
-- db.rls(ctx, fn, { write: true }) calls this.
CREATE FUNCTION audit.lock_tenant() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant uuid := private.ctx_tenant();
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'audit.lock_tenant: no tenant context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('audit:' || v_tenant::text, 0));
END
$$;
--> statement-breakpoint

-- ── Verifying ───────────────────────────────────────────────────────────────
-- Walk one tenant's chain from the start. Reports the first entry that is wrong: a gap or
-- duplicate in seq, a prev_hash that does not match, or contents that do not match the hash.
CREATE FUNCTION audit.verify_chain(p_tenant uuid)
RETURNS TABLE (ok boolean, checked bigint, bad_seq bigint, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  r        audit.log%ROWTYPE;
  v_prev   text := audit.genesis_hash(p_tenant);
  v_expect bigint := 1;
  v_count  bigint := 0;
BEGIN
  FOR r IN SELECT * FROM audit.log WHERE tenant_id = p_tenant ORDER BY seq LOOP
    v_count := v_count + 1;
    IF r.seq <> v_expect THEN
      RETURN QUERY SELECT false, v_count, r.seq, format('entries are missing or duplicated: expected seq %s', v_expect);
      RETURN;
    END IF;
    IF r.prev_hash <> v_prev THEN
      RETURN QUERY SELECT false, v_count, r.seq, 'prev_hash does not match the previous entry';
      RETURN;
    END IF;
    IF r.hash <> audit.compute_hash(r.prev_hash, r.tenant_id, r.seq, r.occurred_at, r.event_key, r.actor_kind,
                                    r.actor_id, r.impersonator_id, r.session_id, r.device_id,
                                    r.pin_verification_id, r.table_name, r.row_id, r.before_data,
                                    r.after_data, r.txid, r.device_at) THEN
      RETURN QUERY SELECT false, v_count, r.seq, 'entry was altered (its hash does not match its contents)';
      RETURN;
    END IF;
    v_prev := r.hash;
    v_expect := v_expect + 1;
  END LOOP;
  RETURN QUERY SELECT true, v_count, NULL::bigint, NULL::text;
END
$$;
--> statement-breakpoint
-- The same check for code running inside db.rls(): only the current tenant.
CREATE FUNCTION audit.verify_own_chain()
RETURNS TABLE (ok boolean, checked bigint, bad_seq bigint, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant uuid := private.ctx_tenant();
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'audit.verify_own_chain: no tenant context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT * FROM audit.verify_chain(v_tenant);
END
$$;
--> statement-breakpoint
-- Compare every anchor with the log. Catches what the chain cannot: newest entries removed, or
-- the whole history rewritten with freshly computed hashes.
CREATE FUNCTION audit.verify_anchors(p_tenant uuid)
RETURNS TABLE (anchor_seq bigint, ok boolean, reason text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT a.seq,
         l.hash IS NOT NULL AND l.hash = a.hash,
         CASE
           WHEN l.hash IS NULL THEN 'the log has no entry at the anchored position (entries were removed)'
           WHEN l.hash <> a.hash THEN 'the entry at the anchored position differs from the anchor (history was rewritten)'
         END
  FROM audit.anchors a
  LEFT JOIN audit.log l ON l.tenant_id = a.tenant_id AND l.seq = a.seq
  WHERE a.tenant_id = p_tenant
  ORDER BY a.seq
$$;
--> statement-breakpoint

-- ── Append-only ─────────────────────────────────────────────────────────────
CREATE FUNCTION audit.reject_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'the audit log is append-only: % on %.% is not allowed', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_immutable_rows BEFORE UPDATE OR DELETE ON audit.log
  FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
--> statement-breakpoint
CREATE TRIGGER audit_log_immutable_truncate BEFORE TRUNCATE ON audit.log
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_change();
--> statement-breakpoint
CREATE TRIGGER audit_anchors_immutable_rows BEFORE UPDATE OR DELETE ON audit.anchors
  FOR EACH ROW EXECUTE FUNCTION audit.reject_change();
--> statement-breakpoint
CREATE TRIGGER audit_anchors_immutable_truncate BEFORE TRUNCATE ON audit.anchors
  FOR EACH STATEMENT EXECUTE FUNCTION audit.reject_change();
--> statement-breakpoint

-- ── Privileges ──────────────────────────────────────────────────────────────
REVOKE ALL ON audit.log, audit.anchors FROM PUBLIC, anon, authenticated, service_role, retail_app;
--> statement-breakpoint
-- Even the owner loses the right to change history. (A superuser can still force it; the hash
-- chain and the anchors are what expose that.)
REVOKE UPDATE, DELETE, TRUNCATE ON audit.log, audit.anchors FROM CURRENT_USER;
--> statement-breakpoint
-- A shop may read ITS OWN entries. Who may look (audit:view) is decided by the app's permission
-- resolver; row-level security only separates tenants. RLS is enabled but not forced: the
-- owner's definer functions are the only writers, and they must be able to insert.
GRANT USAGE ON SCHEMA audit TO authenticated;
--> statement-breakpoint
GRANT SELECT ON audit.log TO authenticated;
--> statement-breakpoint
ALTER TABLE audit.log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_read ON audit.log AS PERMISSIVE FOR SELECT TO authenticated
  USING (tenant_id = (SELECT private.ctx_tenant()));
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  audit.genesis_hash(uuid), audit.append(uuid, text, text, uuid, jsonb, jsonb),
  audit.redact(jsonb, text[]), audit.record_row_change(), audit.record_event_for(uuid, text, jsonb),
  audit.verify_chain(uuid), audit.verify_anchors(uuid), audit.reject_change()
FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit.compute_hash(
  text, uuid, bigint, timestamptz, text, text, uuid, uuid, uuid, uuid, uuid, text, uuid, jsonb, jsonb, bigint, timestamptz
) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit.record_event(text, jsonb), audit.lock_tenant(), audit.verify_own_chain() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION audit.record_event(text, jsonb), audit.lock_tenant(), audit.verify_own_chain() TO authenticated;
--> statement-breakpoint

-- ── Every tenant table is audited ───────────────────────────────────────────
-- Same function as migration 0001, now also attaching the audit trigger, and with two optional
-- lists: columns whose changes are noise (not recorded) and columns whose values are secret
-- (recorded as "[redacted]"). A migration that creates a table calls, for example:
--   select private.secure_tenant_table('app.staff', p_redact => array['pin_hash']);
DROP FUNCTION private.secure_tenant_table(regclass);
--> statement-breakpoint
CREATE FUNCTION private.secure_tenant_table(
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
-- Bring every table that already exists up to date (a no-op while `app` is empty).
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
