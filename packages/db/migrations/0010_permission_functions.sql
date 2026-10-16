-- 0010_permission_functions (hand-written; Phase A task A9, PLAN.md §5, docs/DATA_MODEL.md)
--
-- Who may do what, and who may change who may do what.
--
--   * private.has_permission is the database's copy of core's resolvePermissions: a deny always
--     wins, an allow adds, the Owner role holds everything, a role holds its stored keys. (The
--     "limited to switched-on modules" step is applied by core; the database does not know which
--     key belongs to which module. A test keeps the two identical for a shop with every module on.)
--   * Changes to roles, role permissions, personal overrides and a person's role go through the
--     functions below, which enforce the rules learned from the GraceAndGrind holes:
--       - you can only grant a key you hold;
--       - you cannot change your own permissions or role;
--       - you cannot touch someone above you (whose role holds a key you lack, or an Owner);
--       - only an Owner can make or unmake an Owner;
--       - a deny override really removes the key (has_permission checks it first);
--       - the last Owner of a shop can never be removed (trigger, serialised per shop; SQLSTATE RT008).
--     A direct write to those tables from the shop's own login is refused by a trigger that looks
--     at CURRENT_USER: inside these SECURITY DEFINER functions it is the owner role, a direct
--     statement is `authenticated`. Unlike a setting, it cannot be forged by a caller.
--   * The device functions of migration 0008 now ask for real permissions instead of "owner or manager".
--
-- Rules for this file (see migration 0001): statements are separated by Drizzle's breakpoint
-- marker, which must never appear inside a comment or a string.

-- ── The check ───────────────────────────────────────────────────────────────
CREATE FUNCTION private.has_permission(p_tenant uuid, p_staff uuid, p_key text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_role_id  uuid;
  v_status   text;
  v_effect   text;
  v_role_key text;
BEGIN
  IF p_key IS NULL OR p_key !~ '^[a-z][a-z_]*:[a-z][a-z_]*$' THEN
    RETURN false;
  END IF;
  SELECT st.role_id, st.status::text INTO v_role_id, v_status
  FROM app.staff st WHERE st.tenant_id = p_tenant AND st.id = p_staff;
  IF NOT FOUND OR v_status <> 'active' THEN
    RETURN false;
  END IF;
  SELECT o.effect INTO v_effect
  FROM app.staff_permission_overrides o
  WHERE o.tenant_id = p_tenant AND o.staff_id = p_staff AND o.permission_key = p_key;
  IF v_effect = 'deny' THEN RETURN false; END IF;
  IF v_effect = 'allow' THEN RETURN true; END IF;
  SELECT r.key INTO v_role_key FROM app.roles r WHERE r.tenant_id = p_tenant AND r.id = v_role_id;
  IF v_role_key = 'owner' THEN RETURN true; END IF;
  RETURN EXISTS (
    SELECT 1 FROM app.role_permissions rp
    WHERE rp.tenant_id = p_tenant AND rp.role_id = v_role_id AND rp.permission_key = p_key);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.has_permission(uuid, uuid, text) FROM PUBLIC;
--> statement-breakpoint

-- The request's own person must hold `p_key`, or the request is refused (SQLSTATE 42501).
CREATE FUNCTION private.assert_permission(p_key text) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF NOT private.has_permission(private.ctx_tenant(), private.ctx_staff(), p_key) THEN
    RAISE EXCEPTION 'you do not have the permission %', p_key USING ERRCODE = '42501';
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.assert_permission(text) FROM PUBLIC;
--> statement-breakpoint

-- Does the request's person hold EVERY key of this role? For the Owner role: are they an Owner?
-- (A person cannot give out, or change someone who holds, more than they hold themselves.)
CREATE FUNCTION private.actor_covers_role(p_role uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant uuid := private.ctx_tenant();
  v_actor  uuid := private.ctx_staff();
  v_key    text;
BEGIN
  SELECT r.key INTO v_key FROM app.roles r WHERE r.tenant_id = v_tenant AND r.id = p_role;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_key = 'owner' THEN
    RETURN EXISTS (
      SELECT 1 FROM app.staff st JOIN app.roles r ON r.tenant_id = st.tenant_id AND r.id = st.role_id
      WHERE st.tenant_id = v_tenant AND st.id = v_actor AND st.status = 'active' AND r.key = 'owner');
  END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM app.role_permissions rp
    WHERE rp.tenant_id = v_tenant AND rp.role_id = p_role
      AND NOT private.has_permission(v_tenant, v_actor, rp.permission_key));
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.actor_covers_role(uuid) FROM PUBLIC;
--> statement-breakpoint

-- May the request's person change THIS staff member (their role, overrides, PIN)? They need
-- staff:manage, may not be the same person, and the target may not be above them.
CREATE FUNCTION private.assert_can_manage_staff(p_target uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_role uuid;
BEGIN
  PERFORM private.assert_permission('staff:manage');
  IF p_target IS NOT DISTINCT FROM private.ctx_staff() THEN
    RAISE EXCEPTION 'you cannot change your own permissions' USING ERRCODE = '42501';
  END IF;
  SELECT st.role_id INTO v_role FROM app.staff st WHERE st.tenant_id = private.ctx_tenant() AND st.id = p_target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown staff member' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT private.actor_covers_role(v_role) THEN
    RAISE EXCEPTION 'that person holds permissions you do not' USING ERRCODE = '42501';
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.assert_can_manage_staff(uuid) FROM PUBLIC;
--> statement-breakpoint

-- ── Direct writes from the shop's own login are refused ─────────────────────
CREATE FUNCTION private.guard_permission_writes() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF current_user = 'authenticated' THEN
    RAISE EXCEPTION 'this table is changed through its functions only' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.guard_permission_writes() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER guard_permission_writes BEFORE INSERT OR UPDATE OR DELETE ON app.role_permissions
  FOR EACH ROW EXECUTE FUNCTION private.guard_permission_writes();
--> statement-breakpoint
CREATE TRIGGER guard_permission_writes BEFORE INSERT OR UPDATE OR DELETE ON app.staff_permission_overrides
  FOR EACH ROW EXECUTE FUNCTION private.guard_permission_writes();
--> statement-breakpoint
CREATE TRIGGER guard_permission_writes BEFORE INSERT OR UPDATE OR DELETE ON app.roles
  FOR EACH ROW EXECUTE FUNCTION private.guard_permission_writes();
--> statement-breakpoint
CREATE TRIGGER guard_permission_writes BEFORE INSERT ON app.staff
  FOR EACH ROW EXECUTE FUNCTION private.guard_permission_writes();
--> statement-breakpoint
CREATE TRIGGER guard_permission_writes_role BEFORE UPDATE ON app.staff
  FOR EACH ROW WHEN (OLD.role_id IS DISTINCT FROM NEW.role_id)
  EXECUTE FUNCTION private.guard_permission_writes();
--> statement-breakpoint

-- ── The last Owner can never be removed ─────────────────────────────────────
-- Counts people who hold the Owner role and are active or still invited. Changes are serialised
-- per shop, so two Owners stepping down at the same moment cannot both succeed.
CREATE FUNCTION private.guard_last_owner() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_was_owner boolean;
  v_is_owner  boolean;
BEGIN
  SELECT r.key = 'owner' INTO v_was_owner FROM app.roles r WHERE r.tenant_id = OLD.tenant_id AND r.id = OLD.role_id;
  IF NOT COALESCE(v_was_owner, false) OR OLD.status NOT IN ('active', 'invited') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT r.key = 'owner' INTO v_is_owner FROM app.roles r WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.role_id;
    IF COALESCE(v_is_owner, false) AND NEW.status IN ('active', 'invited') THEN
      RETURN NEW;
    END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('owners:' || OLD.tenant_id::text, 0));
  IF NOT EXISTS (
    SELECT 1 FROM app.staff s JOIN app.roles r ON r.tenant_id = s.tenant_id AND r.id = s.role_id
    WHERE s.tenant_id = OLD.tenant_id AND s.id <> OLD.id AND r.key = 'owner' AND s.status IN ('active', 'invited')
  ) THEN
    RAISE EXCEPTION 'a shop must keep at least one owner' USING ERRCODE = 'RT008';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.guard_last_owner() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER guard_last_owner BEFORE UPDATE OF role_id, status OR DELETE ON app.staff
  FOR EACH ROW EXECUTE FUNCTION private.guard_last_owner();
--> statement-breakpoint

-- The Owner role itself can never be deleted, renamed or archived.
CREATE FUNCTION private.guard_owner_role() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.key = 'owner' AND (TG_OP = 'DELETE' OR NEW.key <> 'owner' OR NEW.archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'the owner role cannot be removed, renamed or archived' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.guard_owner_role() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER guard_owner_role BEFORE UPDATE OR DELETE ON app.roles
  FOR EACH ROW EXECUTE FUNCTION private.guard_owner_role();
--> statement-breakpoint

-- ── Changing people and permissions, through rules ──────────────────────────
-- A person with no account and a PIN to be set (a cashier): active at once. The role they get may
-- not hold anything the creator lacks, and only an Owner can create an Owner.
CREATE FUNCTION app.create_staff(
  p_id uuid, p_display_name text, p_role_id uuid, p_phone text DEFAULT NULL, p_branch_ids uuid[] DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM private.assert_permission('staff:manage');
  IF NOT EXISTS (SELECT 1 FROM app.roles r WHERE r.tenant_id = private.ctx_tenant() AND r.id = p_role_id AND r.archived_at IS NULL) THEN
    RAISE EXCEPTION 'unknown role' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT private.actor_covers_role(p_role_id) THEN
    RAISE EXCEPTION 'that role holds permissions you do not' USING ERRCODE = '42501';
  END IF;
  INSERT INTO app.staff (id, tenant_id, created_by, display_name, phone, role_id, branch_ids, status)
  VALUES (p_id, private.ctx_tenant(), private.ctx_staff(), p_display_name, p_phone, p_role_id, p_branch_ids, 'active');
  RETURN p_id;
END
$$;
--> statement-breakpoint

CREATE FUNCTION app.set_staff_role(p_staff_id uuid, p_role_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM private.assert_can_manage_staff(p_staff_id);
  IF NOT EXISTS (SELECT 1 FROM app.roles r WHERE r.tenant_id = private.ctx_tenant() AND r.id = p_role_id AND r.archived_at IS NULL) THEN
    RAISE EXCEPTION 'unknown role' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT private.actor_covers_role(p_role_id) THEN
    RAISE EXCEPTION 'that role holds permissions you do not' USING ERRCODE = '42501';
  END IF;
  UPDATE app.staff SET role_id = p_role_id
  WHERE app.staff.tenant_id = private.ctx_tenant() AND app.staff.id = p_staff_id;
END
$$;
--> statement-breakpoint

-- Give a CUSTOM role a key, or take it away. System roles are changed only from the platform
-- console (PLAN.md D7). You cannot edit the role you hold, and you can only touch keys you hold.
CREATE FUNCTION app.set_role_permission(p_role_id uuid, p_key text, p_granted boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_is_system boolean;
BEGIN
  PERFORM private.assert_permission('role:manage');
  SELECT r.is_system INTO v_is_system FROM app.roles r WHERE r.tenant_id = private.ctx_tenant() AND r.id = p_role_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown role' USING ERRCODE = 'check_violation';
  END IF;
  IF v_is_system THEN
    RAISE EXCEPTION 'system roles are changed from the platform console only' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM app.staff st WHERE st.tenant_id = private.ctx_tenant() AND st.id = private.ctx_staff() AND st.role_id = p_role_id) THEN
    RAISE EXCEPTION 'you cannot change the role you hold' USING ERRCODE = '42501';
  END IF;
  IF NOT private.has_permission(private.ctx_tenant(), private.ctx_staff(), p_key) THEN
    RAISE EXCEPTION 'you can only change keys you hold' USING ERRCODE = '42501';
  END IF;
  IF p_granted THEN
    INSERT INTO app.role_permissions (id, tenant_id, created_by, role_id, permission_key)
    VALUES (gen_random_uuid(), private.ctx_tenant(), private.ctx_staff(), p_role_id, p_key)
    ON CONFLICT (tenant_id, role_id, permission_key) DO NOTHING;
  ELSE
    DELETE FROM app.role_permissions
    WHERE app.role_permissions.tenant_id = private.ctx_tenant() AND app.role_permissions.role_id = p_role_id AND app.role_permissions.permission_key = p_key;
  END IF;
END
$$;
--> statement-breakpoint

-- A personal exception for one person. Allowing needs you to hold the key; denying needs only
-- that the person is not above you. A reason is required.
CREATE FUNCTION app.set_override(p_staff_id uuid, p_key text, p_effect text, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  PERFORM private.assert_can_manage_staff(p_staff_id);
  IF p_effect NOT IN ('allow', 'deny') THEN
    RAISE EXCEPTION 'effect must be allow or deny' USING ERRCODE = 'check_violation';
  END IF;
  IF p_effect = 'allow' AND NOT private.has_permission(private.ctx_tenant(), private.ctx_staff(), p_key) THEN
    RAISE EXCEPTION 'you can only grant keys you hold' USING ERRCODE = '42501';
  END IF;
  INSERT INTO app.staff_permission_overrides (id, tenant_id, created_by, staff_id, permission_key, effect, reason, granted_by)
  VALUES (gen_random_uuid(), private.ctx_tenant(), private.ctx_staff(), p_staff_id, p_key, p_effect, p_reason, private.ctx_staff())
  ON CONFLICT (tenant_id, staff_id, permission_key)
  DO UPDATE SET effect = EXCLUDED.effect, reason = EXCLUDED.reason, granted_by = EXCLUDED.granted_by;
END
$$;
--> statement-breakpoint

-- Taking an exception away. Removing a DENY gives the key back, so it counts as a grant.
CREATE FUNCTION app.remove_override(p_staff_id uuid, p_key text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_effect text;
BEGIN
  PERFORM private.assert_can_manage_staff(p_staff_id);
  SELECT o.effect INTO v_effect FROM app.staff_permission_overrides o
  WHERE o.tenant_id = private.ctx_tenant() AND o.staff_id = p_staff_id AND o.permission_key = p_key;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF v_effect = 'deny' AND NOT private.has_permission(private.ctx_tenant(), private.ctx_staff(), p_key) THEN
    RAISE EXCEPTION 'you can only grant keys you hold' USING ERRCODE = '42501';
  END IF;
  DELETE FROM app.staff_permission_overrides o
  WHERE o.tenant_id = private.ctx_tenant() AND o.staff_id = p_staff_id AND o.permission_key = p_key;
  RETURN true;
END
$$;
--> statement-breakpoint

-- ── The device and PIN functions now ask for real permissions ───────────────
CREATE OR REPLACE FUNCTION app.create_pairing_code(p_id uuid, p_branch_id uuid, p_code_hash text) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_expires timestamptz := now() + interval '10 minutes';
BEGIN
  PERFORM private.assert_permission('device:manage');
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

CREATE OR REPLACE FUNCTION app.revoke_device(p_device_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_count integer;
BEGIN
  PERFORM private.assert_permission('device:manage');
  UPDATE app.devices SET revoked_at = now(), revoked_by = private.ctx_staff()
  WHERE app.devices.tenant_id = private.ctx_tenant() AND app.devices.id = p_device_id AND app.devices.revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.unlock_device(p_device_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_count integer;
BEGIN
  PERFORM private.assert_permission('device:manage');
  UPDATE app.devices SET pin_failed_count = 0, pin_locked_until = NULL
  WHERE app.devices.tenant_id = private.ctx_tenant() AND app.devices.id = p_device_id AND app.devices.revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END
$$;
--> statement-breakpoint

-- Your own PIN, or (staff:manage) someone who is not above you.
CREATE OR REPLACE FUNCTION app.set_staff_pin(p_staff_id uuid, p_pin_hash text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_pin_hash !~ '^pbkdf2-sha256\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$' THEN
    RAISE EXCEPTION 'not a PIN hash' USING ERRCODE = 'check_violation';
  END IF;
  IF p_staff_id IS DISTINCT FROM private.ctx_staff() THEN
    PERFORM private.assert_can_manage_staff(p_staff_id);
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

-- An approval is only given by someone who holds the permission of the action being approved
-- (the action key IS a permission key). Someone who does not is 'cannot_approve', and the attempt
-- is not counted against them.
DROP FUNCTION app.step_up_begin(uuid);
--> statement-breakpoint
CREATE FUNCTION app.step_up_begin(p_approver_id uuid, p_action_key text) RETURNS TABLE (status text, pin_hash text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  r record;
BEGIN
  IF private.ctx_tenant() IS NULL OR private.ctx_session() IS NULL THEN
    RAISE EXCEPTION 'no session' USING ERRCODE = '28000';
  END IF;
  IF NOT private.has_permission(private.ctx_tenant(), p_approver_id, p_action_key) THEN
    RETURN QUERY SELECT 'cannot_approve'::text, NULL::text;
    RETURN;
  END IF;
  SELECT * INTO r FROM private.pin_attempt(private.ctx_tenant(), private.session_device(), p_approver_id);
  RETURN QUERY SELECT r.o_status, CASE WHEN r.o_status = 'ok' THEN r.o_pin_hash END;
END
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.step_up_finish(p_id uuid, p_approver_id uuid, p_action_key text, p_entity_id uuid DEFAULT NULL)
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
  IF NOT FOUND OR NOT private.has_permission(v_tenant, p_approver_id, p_action_key) THEN
    RAISE EXCEPTION 'cannot approve' USING ERRCODE = 'RT007';
  END IF;
  PERFORM private.pin_success(v_tenant, v_device, p_approver_id);
  INSERT INTO app.pin_verifications (id, tenant_id, staff_id, requested_by, device_id, action_key, entity_id, expires_at)
  VALUES (p_id, v_tenant, p_approver_id, private.ctx_staff(), v_device, p_action_key, p_entity_id, v_expires);
  RETURN v_expires;
END
$$;
--> statement-breakpoint

DROP FUNCTION private.assert_staff_manager();
--> statement-breakpoint

-- ── Who may call what ───────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION
  app.create_staff(uuid, text, uuid, text, uuid[]),
  app.set_staff_role(uuid, uuid),
  app.set_role_permission(uuid, text, boolean),
  app.set_override(uuid, text, text, text),
  app.remove_override(uuid, text),
  app.step_up_begin(uuid, text)
FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  app.create_staff(uuid, text, uuid, text, uuid[]),
  app.set_staff_role(uuid, uuid),
  app.set_role_permission(uuid, text, boolean),
  app.set_override(uuid, text, text, text),
  app.remove_override(uuid, text),
  app.step_up_begin(uuid, text)
TO authenticated;
--> statement-breakpoint

-- ── Securing the new table ──────────────────────────────────────────────────
SELECT private.secure_tenant_table('app.staff_permission_overrides');
