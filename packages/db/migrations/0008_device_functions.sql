-- 0008_device_functions (hand-written; Phase A task A8, docs/DATA_MODEL.md §3.2)
--
-- Paired devices, PIN sign-in, lockouts and one-time PIN approvals ("step-up").
--
-- Two rules shape everything here:
--   1. Anything that COUNTS a failure must not raise an error on failure: an error rolls the
--      whole transaction back, counter included, and the attacker would get unlimited guesses.
--      Those functions return a status instead (ok / locked / invalid ...).
--   2. A PIN is checked by the web server (it is slow to hash, see core: verifyPin), not here.
--      So every attempt is counted as a failure UP FRONT, and a correct PIN then clears the count.
--      That closes the race where many guesses are started before the first one finishes: at
--      most five are ever let through per lock window. The fifth failure locks for 15 minutes.
--
-- Who may manage devices is, until the permission resolver exists (task A9), "an active Owner or
-- Manager". A9 replaces private.assert_staff_manager with a real permission check.
--
-- Rules for this file (see migration 0001): statements are separated by Drizzle's breakpoint
-- marker, which must never appear inside a comment or a string.

-- ── Rate limits (counters that must survive a failed request) ───────────────
CREATE TABLE private.rate_limits (
  key          text        PRIMARY KEY,
  window_start timestamptz NOT NULL,
  hits         integer     NOT NULL CHECK (hits >= 0)
);
--> statement-breakpoint
REVOKE ALL ON private.rate_limits FROM PUBLIC, anon, authenticated, service_role, retail_app;
--> statement-breakpoint

-- True while `p_key` has made at most `p_max` attempts in the current window; false once over.
CREATE FUNCTION private.hit_rate_limit(p_key text, p_max integer, p_window_seconds integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_hits integer;
BEGIN
  IF random() < 0.01 THEN
    DELETE FROM private.rate_limits WHERE window_start < now() - interval '1 day';
  END IF;
  INSERT INTO private.rate_limits AS r (key, window_start, hits) VALUES (p_key, now(), 1)
  ON CONFLICT (key) DO UPDATE SET
    window_start = CASE WHEN r.window_start + make_interval(secs => p_window_seconds) <= now() THEN now() ELSE r.window_start END,
    hits         = CASE WHEN r.window_start + make_interval(secs => p_window_seconds) <= now() THEN 1 ELSE r.hits + 1 END
  RETURNING r.hits INTO v_hits;
  RETURN v_hits <= p_max;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.hit_rate_limit(text, integer, integer) FROM PUBLIC;
--> statement-breakpoint

-- ── Small helpers ───────────────────────────────────────────────────────────
CREATE FUNCTION private.assert_staff_manager() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.staff st JOIN app.roles r ON r.tenant_id = st.tenant_id AND r.id = st.role_id
    WHERE st.tenant_id = private.ctx_tenant() AND st.id = private.ctx_staff()
      AND st.status = 'active' AND r.key IN ('owner', 'manager')
  ) THEN
    RAISE EXCEPTION 'only an owner or manager may do this' USING ERRCODE = '42501';
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.assert_staff_manager() FROM PUBLIC;
--> statement-breakpoint

-- The device this request's session signed in on (null for the admin app).
CREATE FUNCTION private.session_device() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT s.device_id FROM app.staff_sessions s
  WHERE s.id = private.ctx_session() AND s.tenant_id = private.ctx_tenant()
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.session_device() FROM PUBLIC;
--> statement-breakpoint

-- ── A revoked device ends its sessions, and stays revoked ───────────────────
CREATE OR REPLACE FUNCTION private.assert_session_active() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_session uuid := private.ctx_session();
  v_tenant  uuid := private.ctx_tenant();
  v_staff   uuid := private.ctx_staff();
  v_ok      boolean;
BEGIN
  SELECT true INTO v_ok
  FROM app.staff_sessions s
  JOIN app.staff st ON st.tenant_id = s.tenant_id AND st.id = s.staff_id
  JOIN platform.tenants t ON t.id = s.tenant_id
  WHERE s.id = v_session
    AND s.tenant_id = v_tenant
    AND s.staff_id = v_staff
    AND s.ended_at IS NULL
    AND s.expires_at > now()
    AND st.status = 'active'
    AND t.status <> 'closed'
    AND (s.device_id IS NULL OR EXISTS (
      SELECT 1 FROM app.devices d WHERE d.tenant_id = s.tenant_id AND d.id = s.device_id AND d.revoked_at IS NULL));
  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'session is not active' USING ERRCODE = '28000';
  END IF;
END
$$;
--> statement-breakpoint

CREATE FUNCTION private.end_sessions_when_device_revoked() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE app.staff_sessions
  SET ended_at = now(), ended_reason = 'device_revoked'
  WHERE tenant_id = NEW.tenant_id AND device_id = NEW.id AND ended_at IS NULL;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.end_sessions_when_device_revoked() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER end_sessions_on_revoke AFTER UPDATE OF revoked_at ON app.devices
  FOR EACH ROW
  WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL)
  EXECUTE FUNCTION private.end_sessions_when_device_revoked();
--> statement-breakpoint

-- A device's secret never changes (a new secret means a new device), and revoking is permanent.
CREATE FUNCTION private.guard_device_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.token_hash IS DISTINCT FROM OLD.token_hash THEN
    RAISE EXCEPTION 'a device token cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by) THEN
    RAISE EXCEPTION 'a revoked device stays revoked' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.guard_device_update() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER guard_device_update BEFORE UPDATE ON app.devices
  FOR EACH ROW EXECUTE FUNCTION private.guard_device_update();
--> statement-breakpoint

-- A PIN approval can only be used up, once. Nothing else about it may change.
CREATE FUNCTION private.guard_pin_verification_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.consumed_at IS NOT NULL
     OR NEW.consumed_at IS NULL
     OR (NEW.id, NEW.tenant_id, NEW.staff_id, NEW.requested_by, NEW.device_id, NEW.action_key, NEW.entity_id, NEW.verified_at, NEW.expires_at)
        IS DISTINCT FROM
        (OLD.id, OLD.tenant_id, OLD.staff_id, OLD.requested_by, OLD.device_id, OLD.action_key, OLD.entity_id, OLD.verified_at, OLD.expires_at)
  THEN
    RAISE EXCEPTION 'a PIN approval can only be marked used, once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.guard_pin_verification_update() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER guard_pin_verification_update BEFORE UPDATE ON app.pin_verifications
  FOR EACH ROW EXECUTE FUNCTION private.guard_pin_verification_update();
--> statement-breakpoint

-- ── The lockout rule (core: afterPinFailure; a test keeps the two identical) ─
CREATE FUNCTION private.pin_failure_step(
  p_count integer, p_locked timestamptz, p_now timestamptz, OUT new_count integer, OUT new_locked timestamptz
) RETURNS record
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_locked IS NOT NULL AND p_locked > p_now THEN
    new_count := p_count;
    new_locked := p_locked;
    RETURN;
  END IF;
  new_count := p_count + 1;
  new_locked := NULL;
  IF new_count >= 5 THEN
    new_count := 0;
    new_locked := p_now + interval '15 minutes';
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.pin_failure_step(integer, timestamptz, timestamptz) FROM PUBLIC;
--> statement-breakpoint

-- One PIN attempt, counted as a failure up front (see the top of this file).
-- o_status: ok | no_device | cannot_sign_in | locked. The caller has NOT checked the PIN yet.
CREATE FUNCTION private.pin_attempt(p_tenant uuid, p_device uuid, p_staff uuid, OUT o_status text, OUT o_pin_hash text)
RETURNS record
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_now        timestamptz := now();
  v_branch     uuid;
  v_branches   uuid[];
  v_dev_count  integer;
  v_dev_locked timestamptz;
  v_st_count   integer;
  v_st_locked  timestamptz;
  v_hash       text;
  r            record;
BEGIN
  -- Same order as every writer: the shop's audit lock first, then rows (see audit.lock_tenant).
  PERFORM pg_advisory_xact_lock(hashtextextended('audit:' || p_tenant::text, 0));

  IF p_device IS NOT NULL THEN
    SELECT d.branch_id, d.pin_failed_count, d.pin_locked_until INTO v_branch, v_dev_count, v_dev_locked
    FROM app.devices d
    WHERE d.tenant_id = p_tenant AND d.id = p_device AND d.revoked_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN
      o_status := 'no_device';
      RETURN;
    END IF;
  END IF;

  SELECT st.pin_hash, st.branch_ids, st.pin_failed_count, st.pin_locked_until
  INTO v_hash, v_branches, v_st_count, v_st_locked
  FROM app.staff st
  WHERE st.tenant_id = p_tenant AND st.id = p_staff AND st.status = 'active' AND st.pin_hash IS NOT NULL
  FOR UPDATE;
  IF NOT FOUND OR (p_device IS NOT NULL AND v_branches IS NOT NULL AND NOT (v_branch = ANY (v_branches))) THEN
    o_status := 'cannot_sign_in';
    RETURN;
  END IF;

  IF (v_dev_locked IS NOT NULL AND v_dev_locked > v_now) OR (v_st_locked IS NOT NULL AND v_st_locked > v_now) THEN
    o_status := 'locked';
    RETURN;
  END IF;

  SELECT * INTO r FROM private.pin_failure_step(v_st_count, v_st_locked, v_now);
  UPDATE app.staff SET pin_failed_count = r.new_count, pin_locked_until = r.new_locked
  WHERE app.staff.tenant_id = p_tenant AND app.staff.id = p_staff;
  IF r.new_locked IS NOT NULL THEN
    PERFORM audit.record_event_for(p_tenant, 'pin.staff_locked',
      jsonb_build_object('staff_id', p_staff, 'device_id', p_device, 'locked_until', r.new_locked));
  END IF;

  IF p_device IS NOT NULL THEN
    SELECT * INTO r FROM private.pin_failure_step(v_dev_count, v_dev_locked, v_now);
    UPDATE app.devices SET pin_failed_count = r.new_count, pin_locked_until = r.new_locked
    WHERE app.devices.tenant_id = p_tenant AND app.devices.id = p_device;
    IF r.new_locked IS NOT NULL THEN
      PERFORM audit.record_event_for(p_tenant, 'pin.device_locked',
        jsonb_build_object('device_id', p_device, 'locked_until', r.new_locked));
    END IF;
  END IF;

  o_status := 'ok';
  o_pin_hash := v_hash;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.pin_attempt(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint

-- A correct PIN clears both counters.
CREATE FUNCTION private.pin_success(p_tenant uuid, p_device uuid, p_staff uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE app.staff SET pin_failed_count = 0, pin_locked_until = NULL
  WHERE app.staff.tenant_id = p_tenant AND app.staff.id = p_staff;
  IF p_device IS NOT NULL THEN
    UPDATE app.devices SET pin_failed_count = 0, pin_locked_until = NULL, last_seen_at = now()
    WHERE app.devices.tenant_id = p_tenant AND app.devices.id = p_device;
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.pin_success(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint

-- ── Pairing a device ────────────────────────────────────────────────────────
-- An owner or manager makes a one-time code; the person at the new device types or scans it.
CREATE FUNCTION app.create_pairing_code(p_id uuid, p_branch_id uuid, p_code_hash text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_expires timestamptz := now() + interval '10 minutes';
BEGIN
  PERFORM private.assert_staff_manager();
  IF NOT EXISTS (
    SELECT 1 FROM app.branches b
    WHERE b.tenant_id = private.ctx_tenant() AND b.id = p_branch_id AND b.archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'unknown branch' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO app.device_pairing_codes (id, tenant_id, created_by, branch_id, code_hash, expires_at)
  VALUES (p_id, private.ctx_tenant(), private.ctx_staff(), p_branch_id, p_code_hash, v_expires);
  RETURN v_expires;
END
$$;
--> statement-breakpoint

-- Called by the new device itself: it has no account and no shop yet, only the code.
-- status: ok | invalid | rate_limited. A wrong guess is counted (and so is the right one), so
-- guessing is capped per address and across the whole platform.
CREATE FUNCTION app.pair_device(
  p_code_hash text, p_device_id uuid, p_token_hash text, p_name text, p_kind text, p_user_agent text, p_rate_key text
) RETURNS TABLE (status text, tenant_id uuid, branch_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant  uuid;
  v_branch  uuid;
  v_creator uuid;
  v_code    uuid;
BEGIN
  IF NOT private.hit_rate_limit('pair:from:' || p_rate_key, 10, 600)
     OR NOT private.hit_rate_limit('pair:all', 300, 600) THEN
    RETURN QUERY SELECT 'rate_limited'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  SELECT c.id, c.tenant_id, c.branch_id, c.created_by INTO v_code, v_tenant, v_branch, v_creator
  FROM app.device_pairing_codes c
  JOIN platform.tenants t ON t.id = c.tenant_id
  JOIN app.branches b ON b.tenant_id = c.tenant_id AND b.id = c.branch_id
  JOIN app.staff st ON st.tenant_id = c.tenant_id AND st.id = c.created_by
  WHERE c.code_hash = p_code_hash
    AND c.used_at IS NULL
    AND c.expires_at > now()
    AND t.status NOT IN ('paused', 'closed')
    AND b.archived_at IS NULL
    AND st.status = 'active'
  FOR UPDATE OF c;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('audit:' || v_tenant::text, 0));
  PERFORM set_config('app.staff_id', v_creator::text, true);
  INSERT INTO app.devices (id, tenant_id, created_by, branch_id, name, kind, token_hash, paired_by, user_agent)
  VALUES (p_device_id, v_tenant, v_creator, v_branch, btrim(p_name), p_kind, p_token_hash, v_creator, left(p_user_agent, 300));
  UPDATE app.device_pairing_codes SET used_at = now(), used_by_device_id = p_device_id
  WHERE app.device_pairing_codes.tenant_id = v_tenant AND app.device_pairing_codes.id = v_code;
  RETURN QUERY SELECT 'ok'::text, v_tenant, v_branch;
END
$$;
--> statement-breakpoint

-- Revoking: the device can no longer sign anyone in, and its open sessions end (trigger above).
CREATE FUNCTION app.revoke_device(p_device_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_count integer;
BEGIN
  PERFORM private.assert_staff_manager();
  UPDATE app.devices SET revoked_at = now(), revoked_by = private.ctx_staff()
  WHERE app.devices.tenant_id = private.ctx_tenant() AND app.devices.id = p_device_id AND app.devices.revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END
$$;
--> statement-breakpoint

-- A till locked by wrong PINs (five in a row, by anyone) is opened early by an owner or manager.
-- A person's own lock is cleared by giving them a new PIN (app.set_staff_pin).
CREATE FUNCTION app.unlock_device(p_device_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_count integer;
BEGIN
  PERFORM private.assert_staff_manager();
  UPDATE app.devices SET pin_failed_count = 0, pin_locked_until = NULL
  WHERE app.devices.tenant_id = private.ctx_tenant() AND app.devices.id = p_device_id AND app.devices.revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END
$$;
--> statement-breakpoint

-- ── What a device may ask before anyone has signed in ───────────────────────
-- Both return nothing for an unknown or revoked device (or a closed shop).
CREATE FUNCTION app.device_info(p_token_hash text)
RETURNS TABLE (device_id uuid, tenant_id uuid, branch_id uuid, device_name text, tenant_slug text, tenant_display_name jsonb, locked_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT d.id, d.tenant_id, d.branch_id, d.name, t.slug, t.display_name, d.pin_locked_until
  FROM app.devices d JOIN platform.tenants t ON t.id = d.tenant_id
  WHERE d.token_hash = p_token_hash AND d.revoked_at IS NULL AND t.status <> 'closed'
$$;
--> statement-breakpoint

-- The people who can sign in at this till: active, with a PIN, allowed in the device's branch.
CREATE FUNCTION app.device_staff(p_token_hash text)
RETURNS TABLE (staff_id uuid, display_name text, locked boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT st.id, st.display_name, coalesce(st.pin_locked_until > now(), false)
  FROM app.devices d
  JOIN platform.tenants t ON t.id = d.tenant_id
  JOIN app.staff st ON st.tenant_id = d.tenant_id
  WHERE d.token_hash = p_token_hash AND d.revoked_at IS NULL AND t.status <> 'closed'
    AND st.status = 'active' AND st.pin_hash IS NOT NULL
    AND (st.branch_ids IS NULL OR d.branch_id = ANY (st.branch_ids))
  ORDER BY st.display_name, st.id
$$;
--> statement-breakpoint

-- ── PIN sign-in at a paired device ──────────────────────────────────────────
-- Step 1: begin. status ok | no_device | cannot_sign_in | locked. On ok the stored PIN hash is
-- returned so the server can check the PIN; the attempt is already counted as a failure.
CREATE FUNCTION app.pin_attempt_begin(p_token_hash text, p_staff_id uuid)
RETURNS TABLE (status text, pin_hash text, tenant_id uuid, device_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant uuid;
  v_device uuid;
  r        record;
BEGIN
  SELECT d.tenant_id, d.id INTO v_tenant, v_device
  FROM app.devices d JOIN platform.tenants t ON t.id = d.tenant_id
  WHERE d.token_hash = p_token_hash AND d.revoked_at IS NULL AND t.status <> 'closed';
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'no_device'::text, NULL::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;
  SELECT * INTO r FROM private.pin_attempt(v_tenant, v_device, p_staff_id);
  IF r.o_status = 'ok' THEN
    RETURN QUERY SELECT r.o_status, r.o_pin_hash, v_tenant, v_device;
  ELSE
    RETURN QUERY SELECT r.o_status, NULL::text, NULL::uuid, NULL::uuid;
  END IF;
END
$$;
--> statement-breakpoint

-- Step 2, only after the server found the PIN correct: clear the counters and open the session.
-- The session id is made by the caller (UUIDv7) so the cookie can carry it; a till session lasts
-- at most 24 hours (the app asks for 12).
CREATE FUNCTION app.pin_sign_in_finish(p_token_hash text, p_staff_id uuid, p_session_id uuid, p_expires_at timestamptz)
RETURNS TABLE (tenant_id uuid, staff_id uuid, device_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant uuid;
  v_device uuid;
  v_branch uuid;
  v_branches uuid[];
BEGIN
  IF p_expires_at <= now() OR p_expires_at > now() + interval '24 hours' THEN
    RAISE EXCEPTION 'pin_sign_in_finish: expiry must be within the next 24 hours' USING ERRCODE = 'check_violation';
  END IF;
  SELECT d.tenant_id, d.id, d.branch_id INTO v_tenant, v_device, v_branch
  FROM app.devices d JOIN platform.tenants t ON t.id = d.tenant_id
  WHERE d.token_hash = p_token_hash AND d.revoked_at IS NULL AND t.status <> 'closed';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'device not recognised' USING ERRCODE = '28000';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('audit:' || v_tenant::text, 0));
  SELECT st.branch_ids INTO v_branches
  FROM app.staff st
  WHERE st.tenant_id = v_tenant AND st.id = p_staff_id AND st.status = 'active' AND st.pin_hash IS NOT NULL
  FOR UPDATE;
  IF NOT FOUND OR (v_branches IS NOT NULL AND NOT (v_branch = ANY (v_branches))) THEN
    RAISE EXCEPTION 'cannot sign in' USING ERRCODE = '28000';
  END IF;

  PERFORM private.pin_success(v_tenant, v_device, p_staff_id);
  PERFORM set_config('app.staff_id', p_staff_id::text, true);
  PERFORM set_config('app.device_id', v_device::text, true);
  INSERT INTO app.staff_sessions (id, tenant_id, staff_id, device_id, method, expires_at)
  VALUES (p_session_id, v_tenant, p_staff_id, v_device, 'pin', p_expires_at);
  RETURN QUERY SELECT v_tenant, p_staff_id, v_device;
END
$$;
--> statement-breakpoint

-- ── Setting a PIN ───────────────────────────────────────────────────────────
-- Anyone may set their OWN PIN. An owner or manager may set someone else's, except that only an
-- owner may touch an owner's (otherwise a manager could take over the owner's till access).
-- The server checks strength and hashes it (core: checkNewPin, hashPin); we only check the shape.
CREATE FUNCTION app.set_staff_pin(p_staff_id uuid, p_pin_hash text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_target_role text;
  v_caller_role text;
BEGIN
  IF p_pin_hash !~ '^pbkdf2-sha256\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION 'not a PIN hash' USING ERRCODE = 'check_violation';
  END IF;
  IF p_staff_id IS DISTINCT FROM private.ctx_staff() THEN
    PERFORM private.assert_staff_manager();
    SELECT r.key INTO v_target_role FROM app.staff st
      JOIN app.roles r ON r.tenant_id = st.tenant_id AND r.id = st.role_id
      WHERE st.tenant_id = private.ctx_tenant() AND st.id = p_staff_id;
    SELECT r.key INTO v_caller_role FROM app.staff st
      JOIN app.roles r ON r.tenant_id = st.tenant_id AND r.id = st.role_id
      WHERE st.tenant_id = private.ctx_tenant() AND st.id = private.ctx_staff();
    IF v_target_role = 'owner' AND v_caller_role IS DISTINCT FROM 'owner' THEN
      RAISE EXCEPTION 'only an owner may set an owner''s PIN' USING ERRCODE = '42501';
    END IF;
  END IF;
  UPDATE app.staff
  SET pin_hash = p_pin_hash, pin_set_at = now(), pin_failed_count = 0, pin_locked_until = NULL
  WHERE app.staff.tenant_id = private.ctx_tenant() AND app.staff.id = p_staff_id AND app.staff.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such active staff member' USING ERRCODE = 'check_violation';
  END IF;
END
$$;
--> statement-breakpoint

-- ── One-time PIN approval ("step-up") ───────────────────────────────────────
-- Runs inside a signed-in request (the cashier's). Step 1: begin, for the person whose PIN will
-- be typed. status ok | no_device | cannot_sign_in | locked, exactly as for sign-in.
CREATE FUNCTION app.step_up_begin(p_approver_id uuid) RETURNS TABLE (status text, pin_hash text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  r record;
BEGIN
  IF private.ctx_tenant() IS NULL OR private.ctx_session() IS NULL THEN
    RAISE EXCEPTION 'no session' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO r FROM private.pin_attempt(private.ctx_tenant(), private.session_device(), p_approver_id);
  RETURN QUERY SELECT r.o_status, CASE WHEN r.o_status = 'ok' THEN r.o_pin_hash END;
END
$$;
--> statement-breakpoint

-- Step 2, only after the server found the PIN correct: record the approval. It is good for two
-- minutes, for this one action (and this one record, if given), asked for by this session.
CREATE FUNCTION app.step_up_finish(p_id uuid, p_approver_id uuid, p_action_key text, p_entity_id uuid DEFAULT NULL)
RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant  uuid := private.ctx_tenant();
  v_device  uuid := private.session_device();
  v_expires timestamptz := now() + interval '2 minutes';
BEGIN
  IF v_tenant IS NULL OR private.ctx_session() IS NULL OR private.ctx_staff() IS NULL THEN
    RAISE EXCEPTION 'no session' USING ERRCODE = '28000';
  END IF;
  PERFORM 1 FROM app.staff st
  WHERE st.tenant_id = v_tenant AND st.id = p_approver_id AND st.status = 'active' AND st.pin_hash IS NOT NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cannot approve' USING ERRCODE = 'RT007';
  END IF;
  PERFORM private.pin_success(v_tenant, v_device, p_approver_id);
  INSERT INTO app.pin_verifications (id, tenant_id, staff_id, requested_by, device_id, action_key, entity_id, expires_at)
  VALUES (p_id, v_tenant, p_approver_id, private.ctx_staff(), v_device, p_action_key, p_entity_id, v_expires);
  RETURN v_expires;
END
$$;
--> statement-breakpoint

-- Used by the action being approved. Returns whose PIN approved it, and marks the rest of this
-- transaction as approved by that verification, so the audit log records it. One use only.
CREATE FUNCTION app.consume_step_up(p_id uuid, p_action_key text, p_entity_id uuid DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_approver uuid;
BEGIN
  UPDATE app.pin_verifications v SET consumed_at = now()
  FROM app.staff st
  WHERE v.tenant_id = private.ctx_tenant() AND v.id = p_id
    AND v.requested_by = private.ctx_staff()
    AND v.device_id IS NOT DISTINCT FROM private.session_device()
    AND v.action_key = p_action_key
    AND (v.entity_id IS NULL OR v.entity_id = p_entity_id)
    AND v.consumed_at IS NULL
    AND v.expires_at > now()
    AND st.tenant_id = v.tenant_id AND st.id = v.staff_id AND st.status = 'active'
  RETURNING v.staff_id INTO v_approver;
  IF v_approver IS NULL THEN
    RAISE EXCEPTION 'approval is not valid' USING ERRCODE = 'RT007';
  END IF;
  PERFORM set_config('app.pin_verification_id', p_id::text, true);
  RETURN v_approver;
END
$$;
--> statement-breakpoint

-- ── Who may call what ───────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION
  app.create_pairing_code(uuid, uuid, text),
  app.pair_device(text, uuid, text, text, text, text, text),
  app.revoke_device(uuid),
  app.unlock_device(uuid),
  app.device_info(text),
  app.device_staff(text),
  app.pin_attempt_begin(text, uuid),
  app.pin_sign_in_finish(text, uuid, uuid, timestamptz),
  app.set_staff_pin(uuid, text),
  app.step_up_begin(uuid),
  app.step_up_finish(uuid, uuid, text, uuid),
  app.consume_step_up(uuid, text, uuid)
FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  app.create_pairing_code(uuid, uuid, text),
  app.pair_device(text, uuid, text, text, text, text, text),
  app.revoke_device(uuid),
  app.unlock_device(uuid),
  app.device_info(text),
  app.device_staff(text),
  app.pin_attempt_begin(text, uuid),
  app.pin_sign_in_finish(text, uuid, uuid, timestamptz),
  app.set_staff_pin(uuid, text),
  app.step_up_begin(uuid),
  app.step_up_finish(uuid, uuid, text, uuid),
  app.consume_step_up(uuid, text, uuid)
TO authenticated;
--> statement-breakpoint

-- ── Securing the new tables ─────────────────────────────────────────────────
-- Device tokens and pairing codes are secrets: recorded as "[redacted]". A device's failed-PIN
-- counter and last-seen time change constantly and are not audited as row changes (locks are
-- recorded as events by the functions above).
SELECT private.secure_tenant_table(
  'app.devices',
  p_ignore => ARRAY['pin_failed_count', 'last_seen_at'],
  p_redact => ARRAY['token_hash']
);
--> statement-breakpoint
SELECT private.secure_tenant_table('app.device_pairing_codes', p_redact => ARRAY['code_hash']);
--> statement-breakpoint
SELECT private.secure_tenant_table('app.pin_verifications');
