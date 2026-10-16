-- 0015_staff_status_and_activity (hand-written; Phase A task A15, docs/DATA_MODEL.md)
--
--   * Suspending, reinstating and archiving a person now goes through app.set_staff_status, with
--     the same rules as changing a role: staff:manage, not yourself, not someone above you; the
--     last owner can never be removed (the trigger of migration 0010). A direct change of
--     staff.status from the shop's own login is refused, like a direct change of role.
--     Archived is final here (only the platform console reinstates). An invitation that was never
--     accepted can be cancelled by archiving it.
--   * app.list_activity gives the owner's Activity timeline: the shop's audit entries, newest
--     first, with the people and things they are about already named. It needs audit:view and
--     leaves out noise (a session ending, a pairing code being used up, PIN approvals). The
--     entries themselves are already redacted by the audit triggers (no PIN hashes, no tokens).
--
-- Rules for this file (see migration 0001): statements are separated by Drizzle's breakpoint
-- marker, which must never appear inside a comment or a string.

CREATE TRIGGER guard_permission_writes_status BEFORE UPDATE ON app.staff
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION private.guard_permission_writes();
--> statement-breakpoint

CREATE FUNCTION app.set_staff_status(p_staff_id uuid, p_status text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_from text;
BEGIN
  PERFORM private.assert_can_manage_staff(p_staff_id);
  IF p_status NOT IN ('active', 'suspended', 'archived') THEN
    RAISE EXCEPTION 'status must be active, suspended or archived' USING ERRCODE = 'check_violation';
  END IF;
  SELECT st.status::text INTO v_from FROM app.staff st
  WHERE st.tenant_id = private.ctx_tenant() AND st.id = p_staff_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown staff member' USING ERRCODE = 'check_violation';
  END IF;
  IF v_from = p_status THEN
    RETURN;
  END IF;
  IF v_from = 'archived' THEN
    RAISE EXCEPTION 'an archived person cannot be brought back here' USING ERRCODE = 'check_violation';
  END IF;
  IF v_from = 'invited' AND p_status <> 'archived' THEN
    RAISE EXCEPTION 'this person has not accepted the invitation yet' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE app.staff SET
    status = p_status::app.staff_status,
    invite_token_hash = NULL, invite_email = NULL, invite_expires_at = NULL
  WHERE app.staff.tenant_id = private.ctx_tenant() AND app.staff.id = p_staff_id;
END
$$;
--> statement-breakpoint

-- A uuid from text, or null if it is not one (audit data is ours, but a timeline must never fail on odd data).
CREATE FUNCTION private.try_uuid(p_text text) RETURNS uuid
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN p_text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN p_text::uuid END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.try_uuid(text) FROM PUBLIC;
--> statement-breakpoint

CREATE FUNCTION app.list_activity(p_limit integer DEFAULT 50, p_before_seq bigint DEFAULT NULL, p_about uuid DEFAULT NULL)
RETURNS TABLE (
  seq bigint, occurred_at timestamptz, event_key text, actor_kind text, actor_id uuid, actor_name text,
  table_name text, row_id uuid, subject_id uuid, subject_name text, before_data jsonb, after_data jsonb
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant uuid := private.ctx_tenant();
  v_limit  integer := least(200, greatest(1, coalesce(p_limit, 50)));
BEGIN
  PERFORM private.assert_permission('audit:view');
  RETURN QUERY
  WITH shown AS (
    SELECT l.*,
      CASE
        WHEN l.table_name = 'app.staff_sessions' THEN private.try_uuid(l.after_data ->> 'staff_id')
        WHEN l.event_key = 'pin.staff_locked' THEN private.try_uuid(l.after_data ->> 'staff_id')
        WHEN l.event_key = 'pin.device_locked' THEN private.try_uuid(l.after_data ->> 'device_id')
        WHEN l.table_name = 'app.staff_permission_overrides' THEN
          coalesce(private.try_uuid(l.after_data ->> 'staff_id'), private.try_uuid(l.before_data ->> 'staff_id'),
                   (SELECT o.staff_id FROM app.staff_permission_overrides o WHERE o.tenant_id = v_tenant AND o.id = l.row_id))
        ELSE l.row_id
      END AS subject
    FROM audit.log l
    WHERE l.tenant_id = v_tenant
      AND (p_before_seq IS NULL OR l.seq < p_before_seq)
      AND NOT (l.table_name = 'app.staff_sessions' AND l.event_key = 'row.update')
      AND NOT (l.table_name = 'app.device_pairing_codes' AND l.event_key = 'row.update')
      AND l.table_name IS DISTINCT FROM 'app.pin_verifications'
  )
  SELECT s.seq, s.occurred_at, s.event_key, s.actor_kind, s.actor_id,
         (SELECT a.display_name FROM app.staff a WHERE a.tenant_id = v_tenant AND a.id = s.actor_id),
         s.table_name, s.row_id, s.subject,
         coalesce(
           (SELECT st.display_name FROM app.staff st WHERE st.tenant_id = v_tenant AND st.id = s.subject),
           (SELECT d.name FROM app.devices d WHERE d.tenant_id = v_tenant AND d.id = s.subject),
           (SELECT ts.key FROM app.tenant_settings ts WHERE s.table_name = 'app.tenant_settings' AND ts.tenant_id = v_tenant AND ts.id = s.row_id)),
         s.before_data, s.after_data
  FROM shown s
  WHERE p_about IS NULL OR s.subject = p_about OR s.row_id = p_about
  ORDER BY s.seq DESC
  LIMIT v_limit;
END
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.set_staff_status(uuid, text), app.list_activity(integer, bigint, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.set_staff_status(uuid, text), app.list_activity(integer, bigint, uuid) TO authenticated;
