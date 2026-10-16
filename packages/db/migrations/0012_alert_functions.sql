-- 0012_alert_functions (hand-written; Phase A task A10, PLAN.md §6.3, docs/DATA_MODEL.md)
--
-- Alerts: how they are raised and closed, and the first two rules that raise them (a PIN lockout
-- of a person or of a till).
--
--   * private.raise_alert makes an alert for any shop. System code (the PIN functions) uses it.
--   * app.raise_alert lets the signed-in person's own request raise one (a below-floor sale,
--     later). The caller picks the category and severity here, so the TypeScript helper takes them
--     from core's rule registry. An id made by the caller makes a replay harmless.
--   * app.set_alert_status closes or acknowledges one. It needs alert:resolve, follows the life
--     cycle (new, ack, resolved or dismissed; closed is final), and records who and when.
--   * A direct write to app.alerts from the shop's own login is refused (the same guard as the
--     permission tables), and nothing deletes an alert.
--
-- Rules for this file (see migration 0001): statements are separated by Drizzle's breakpoint
-- marker, which must never appear inside a comment or a string.

CREATE FUNCTION private.raise_alert(
  p_tenant uuid, p_branch uuid, p_rule text, p_category text, p_severity integer,
  p_entity_type text, p_entity_id uuid, p_payload jsonb, p_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_id uuid := COALESCE(p_id, gen_random_uuid());
BEGIN
  INSERT INTO app.alerts (id, tenant_id, branch_id, category, rule_key, severity, entity_type, entity_id, payload)
  VALUES (v_id, p_tenant, p_branch, p_category, p_rule, p_severity, p_entity_type, p_entity_id, COALESCE(p_payload, '{}'::jsonb))
  ON CONFLICT (id) DO NOTHING;
  RETURN v_id;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.raise_alert(uuid, uuid, text, text, integer, text, uuid, jsonb, uuid) FROM PUBLIC;
--> statement-breakpoint

-- From the signed-in person's own request. Any active staff member of the shop may raise one
-- (the system, not the cashier, decides what is suspicious); closing one needs a permission.
CREATE FUNCTION app.raise_alert(
  p_id uuid, p_rule text, p_category text, p_severity integer, p_branch_id uuid DEFAULT NULL,
  p_entity_type text DEFAULT NULL, p_entity_id uuid DEFAULT NULL, p_payload jsonb DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.staff st
    WHERE st.tenant_id = private.ctx_tenant() AND st.id = private.ctx_staff() AND st.status = 'active'
  ) THEN
    RAISE EXCEPTION 'only signed-in staff can raise an alert' USING ERRCODE = '42501';
  END IF;
  RETURN private.raise_alert(private.ctx_tenant(), p_branch_id, p_rule, p_category, p_severity, p_entity_type, p_entity_id, p_payload, p_id);
END
$$;
--> statement-breakpoint

-- The life cycle (core: canTransitionAlert; a test keeps the two identical).
CREATE FUNCTION private.alert_transition_ok(p_from text, p_to text) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT (p_from = 'new' AND p_to IN ('ack', 'resolved', 'dismissed'))
      OR (p_from = 'ack' AND p_to IN ('resolved', 'dismissed'))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.alert_transition_ok(text, text) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION app.set_alert_status(p_alert_id uuid, p_status text, p_note text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_from text;
  v_closing boolean := p_status IN ('resolved', 'dismissed');
BEGIN
  PERFORM private.assert_permission('alert:resolve');
  SELECT a.status INTO v_from FROM app.alerts a
  WHERE a.tenant_id = private.ctx_tenant() AND a.id = p_alert_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown alert' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT private.alert_transition_ok(v_from, p_status) THEN
    RAISE EXCEPTION 'an alert cannot go from % to %', v_from, p_status USING ERRCODE = 'check_violation';
  END IF;
  UPDATE app.alerts SET
    status = p_status,
    assignee_staff_id = CASE WHEN p_status = 'ack' THEN private.ctx_staff() ELSE app.alerts.assignee_staff_id END,
    resolution_note = CASE WHEN v_closing THEN NULLIF(btrim(p_note), '') ELSE app.alerts.resolution_note END,
    resolved_by = CASE WHEN v_closing THEN private.ctx_staff() ELSE NULL END,
    resolved_at = CASE WHEN v_closing THEN now() ELSE NULL END
  WHERE app.alerts.tenant_id = private.ctx_tenant() AND app.alerts.id = p_alert_id;
END
$$;
--> statement-breakpoint

-- ── A PIN lockout is now an alert too ───────────────────────────────────────
-- Same function as migration 0008, plus the alerts. The payload holds ids and the lock time only.
CREATE OR REPLACE FUNCTION private.pin_attempt(p_tenant uuid, p_device uuid, p_staff uuid, OUT o_status text, OUT o_pin_hash text)
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
    PERFORM private.raise_alert(p_tenant, v_branch, 'pin.staff_locked', 'suspicion', 3, 'staff', p_staff,
      jsonb_build_object('staff_id', p_staff, 'device_id', p_device, 'locked_until', r.new_locked));
  END IF;

  IF p_device IS NOT NULL THEN
    SELECT * INTO r FROM private.pin_failure_step(v_dev_count, v_dev_locked, v_now);
    UPDATE app.devices SET pin_failed_count = r.new_count, pin_locked_until = r.new_locked
    WHERE app.devices.tenant_id = p_tenant AND app.devices.id = p_device;
    IF r.new_locked IS NOT NULL THEN
      PERFORM audit.record_event_for(p_tenant, 'pin.device_locked',
        jsonb_build_object('device_id', p_device, 'locked_until', r.new_locked));
      PERFORM private.raise_alert(p_tenant, v_branch, 'pin.device_locked', 'suspicion', 4, 'device', p_device,
        jsonb_build_object('device_id', p_device, 'staff_id', p_staff, 'locked_until', r.new_locked));
    END IF;
  END IF;

  o_status := 'ok';
  o_pin_hash := v_hash;
END
$$;
--> statement-breakpoint

-- ── Who may call what, and no direct writes ─────────────────────────────────
REVOKE ALL ON FUNCTION
  app.raise_alert(uuid, text, text, integer, uuid, text, uuid, jsonb),
  app.set_alert_status(uuid, text, text)
FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  app.raise_alert(uuid, text, text, integer, uuid, text, uuid, jsonb),
  app.set_alert_status(uuid, text, text)
TO authenticated;
--> statement-breakpoint

CREATE TRIGGER guard_permission_writes BEFORE INSERT OR UPDATE OR DELETE ON app.alerts
  FOR EACH ROW EXECUTE FUNCTION private.guard_permission_writes();
--> statement-breakpoint

SELECT private.secure_tenant_table('app.alerts');
