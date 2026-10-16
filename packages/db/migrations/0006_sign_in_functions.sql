-- 0006_sign_in_functions (hand-written; Phase A task A7a, docs/DATA_MODEL.md §2 and §3.2)
--
-- How a person gets from "I have a login account" to "I am acting as this staff member in this
-- shop", and how that is revoked.
--
--   * Two settings carry a VERIFIED account (id and email) before any shop is chosen. The web
--     server fills them in from a checked Supabase token; the database trusts them for the same
--     reason it trusts app.tenant_id: only server code runs SQL (see migration 0001).
--   * app.my_shops, app.accept_invite, app.start_session, app.end_my_session: the only ways to
--     reach staff data BEFORE a shop context exists. They are SECURITY DEFINER with a fixed
--     search_path, and each does exactly one narrow job.
--   * private.assert_session_active runs at the start of every shop request: a session that was
--     ended, has expired, or whose staff member was suspended is refused immediately.
--   * Suspending or archiving a staff member ends their open sessions.
--
-- Custom error codes (SQLSTATE class "RT"): RT001 invitation not valid, RT002 already a member of
-- that shop, RT003 no access to that shop. SQLSTATE 28000 means "sign in again".
--
-- Rules for this file (see migration 0001): statements are separated by Drizzle's breakpoint
-- marker, which must never appear inside a comment or a string.

-- ── A verified account, before a shop is chosen ─────────────────────────────
CREATE FUNCTION private.ctx_auth_user() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$ SELECT private.ctx_uuid('app.auth_user_id') $$;
--> statement-breakpoint
CREATE FUNCTION private.ctx_auth_email() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT lower(NULLIF(btrim(current_setting('app.auth_email', true)), '')) $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.ctx_auth_user(), private.ctx_auth_email() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION private.ctx_auth_user(), private.ctx_auth_email() TO authenticated;
--> statement-breakpoint

-- ── Is this request's session still good? ───────────────────────────────────
-- Called inside the same transaction as the request, so there is no gap between "checked" and
-- "used". Fails closed: a missing staff member, a session of another shop, an ended or expired
-- session, a suspended person or a closed shop all raise 28000. A paused shop is fine: it may
-- still READ (the read-only trigger stops writes).
CREATE FUNCTION private.assert_session_active() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_session uuid := private.ctx_session();
  v_tenant  uuid := private.ctx_tenant();
  v_staff   uuid := private.ctx_staff();
  v_ok      boolean;
BEGIN
  -- Strict on purpose: with no session claimed there is no row to find, so this raises too.
  -- Platform and system code claims no session and is never sent here: runWithRls only calls
  -- this when a session id is present, so a caller that forgets to claim one fails closed instead
  -- of silently passing.
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
    AND t.status <> 'closed';
  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'session is not active' USING ERRCODE = '28000';
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.assert_session_active() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION private.assert_session_active() TO authenticated;
--> statement-breakpoint

-- ── Suspending someone ends their sign-ins ──────────────────────────────────
-- The per-request check above already refuses them; this keeps the stored state honest too
-- (a suspended person's sessions show as ended, with the reason).
CREATE FUNCTION private.end_sessions_when_staff_inactive() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  UPDATE app.staff_sessions
  SET ended_at = now(), ended_reason = 'staff_suspended'
  WHERE tenant_id = NEW.tenant_id AND staff_id = NEW.id AND ended_at IS NULL;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION private.end_sessions_when_staff_inactive() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER end_sessions_on_inactive AFTER UPDATE OF status ON app.staff
  FOR EACH ROW
  WHEN (NEW.status IN ('suspended', 'archived') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION private.end_sessions_when_staff_inactive();
--> statement-breakpoint

-- ── The shop picker ─────────────────────────────────────────────────────────
-- Every shop where the verified account is an ACTIVE staff member. Closed shops are not offered.
CREATE FUNCTION app.my_shops()
RETURNS TABLE (
  tenant_id uuid, slug text, display_name jsonb, tenant_status text,
  staff_id uuid, staff_name text, role_key text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT t.id, t.slug, t.display_name, t.status::text, s.id, s.display_name, r.key
  FROM app.staff s
  JOIN platform.tenants t ON t.id = s.tenant_id
  JOIN app.roles r ON r.tenant_id = s.tenant_id AND r.id = s.role_id
  WHERE s.auth_user_id = private.ctx_auth_user()
    AND s.status = 'active'
    AND t.status <> 'closed'
  ORDER BY t.slug
$$;
--> statement-breakpoint

-- ── Following an invitation ─────────────────────────────────────────────────
-- The caller proves they hold the token (we receive its hash), and the verified account's email
-- must match the invited address. One generic error for every way an invitation can be wrong
-- (unknown, used, expired, wrong email, shop paused or closed), so it cannot be used to probe.
CREATE FUNCTION app.accept_invite(p_token_hash text)
RETURNS TABLE (tenant_id uuid, staff_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_auth  uuid := private.ctx_auth_user();
  v_email text := private.ctx_auth_email();
  v_tenant uuid;
  v_staff  uuid;
  v_rows   integer;
BEGIN
  IF v_auth IS NULL OR v_email IS NULL THEN
    RAISE EXCEPTION 'sign in first' USING ERRCODE = '28000';
  END IF;

  SELECT s.tenant_id, s.id INTO v_tenant, v_staff
  FROM app.staff s
  JOIN platform.tenants t ON t.id = s.tenant_id
  WHERE s.invite_token_hash = p_token_hash
    AND s.status = 'invited'
    AND s.invite_expires_at > now()
    AND s.invite_email = v_email
    AND t.status NOT IN ('paused', 'closed')
  FOR UPDATE OF s;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitation is not valid' USING ERRCODE = 'RT001';
  END IF;

  -- Record the change as made by the person who accepted (the shop is deliberately left out of
  -- the context, so the read-only rule for paused shops is not applied to this one step).
  PERFORM set_config('app.staff_id', v_staff::text, true);
  BEGIN
    UPDATE app.staff
    SET auth_user_id = v_auth, status = 'active',
        invite_token_hash = NULL, invite_email = NULL, invite_expires_at = NULL
    -- (the status test repeats the one above on purpose: even without the row lock, an
    -- invitation that was already claimed can never be claimed a second time)
    WHERE app.staff.tenant_id = v_tenant AND app.staff.id = v_staff AND app.staff.status = 'invited';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'already a member of this shop' USING ERRCODE = 'RT002';
  END;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'invitation is not valid' USING ERRCODE = 'RT001';
  END IF;
  PERFORM audit.append(v_tenant, 'staff.invite_accepted', NULL, v_staff, NULL,
                       jsonb_build_object('staff_id', v_staff));
  RETURN QUERY SELECT v_tenant, v_staff;
END
$$;
--> statement-breakpoint

-- ── Signing in to a shop ────────────────────────────────────────────────────
-- Opens a session for the verified account in the chosen shop. The session id is made by the
-- caller (UUIDv7), so the cookie can carry it. A paused shop may still be entered (read-only).
CREATE FUNCTION app.start_session(
  p_session_id uuid, p_tenant_id uuid, p_method text, p_expires_at timestamptz
) RETURNS TABLE (staff_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_auth  uuid := private.ctx_auth_user();
  v_staff uuid;
BEGIN
  IF v_auth IS NULL THEN
    RAISE EXCEPTION 'sign in first' USING ERRCODE = '28000';
  END IF;
  IF p_method NOT IN ('password', 'google') THEN
    RAISE EXCEPTION 'start_session: method must be password or google' USING ERRCODE = 'check_violation';
  END IF;
  IF p_expires_at <= now() OR p_expires_at > now() + interval '31 days' THEN
    RAISE EXCEPTION 'start_session: expiry must be in the next 31 days' USING ERRCODE = 'check_violation';
  END IF;

  SELECT s.id INTO v_staff
  FROM app.staff s
  JOIN platform.tenants t ON t.id = s.tenant_id
  WHERE s.tenant_id = p_tenant_id AND s.auth_user_id = v_auth AND s.status = 'active' AND t.status <> 'closed';
  IF v_staff IS NULL THEN
    RAISE EXCEPTION 'no access to this shop' USING ERRCODE = 'RT003';
  END IF;

  PERFORM set_config('app.staff_id', v_staff::text, true);
  INSERT INTO app.staff_sessions (id, tenant_id, staff_id, method, expires_at)
  VALUES (p_session_id, p_tenant_id, v_staff, p_method, p_expires_at);
  RETURN QUERY SELECT v_staff;
END
$$;
--> statement-breakpoint

-- ── Signing out ─────────────────────────────────────────────────────────────
-- Ends the request's own session. A PAUSED shop's people must still be able to sign out, but the
-- read-only trigger looks at the request's shop (being SECURITY DEFINER does not exempt a
-- function from it), so this function steps out of the shop for the one update and back in.
CREATE FUNCTION app.end_my_session(p_reason text DEFAULT 'logout') RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_session uuid := private.ctx_session();
  v_tenant  uuid := private.ctx_tenant();
  v_count   integer;
BEGIN
  IF p_reason NOT IN ('logout', 'revoked') THEN
    RAISE EXCEPTION 'end_my_session: reason must be logout or revoked' USING ERRCODE = 'check_violation';
  END IF;
  IF v_session IS NULL OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'no session' USING ERRCODE = '28000';
  END IF;
  PERFORM set_config('app.tenant_id', '', true);
  UPDATE app.staff_sessions
  SET ended_at = now(), ended_reason = p_reason
  WHERE id = v_session AND app.staff_sessions.tenant_id = v_tenant AND ended_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  PERFORM set_config('app.tenant_id', v_tenant::text, true);
  RETURN v_count > 0;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  app.my_shops(), app.accept_invite(text), app.start_session(uuid, uuid, text, timestamptz), app.end_my_session(text)
FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  app.my_shops(), app.accept_invite(text), app.start_session(uuid, uuid, text, timestamptz), app.end_my_session(text)
TO authenticated;
--> statement-breakpoint

-- ── Securing the new tables ─────────────────────────────────────────────────
-- Secrets AND personal contact details are recorded in the audit log as "[redacted]". The log can
-- never be edited, so anything personal written into it could never be erased, which would clash
-- with the right to erasure (PLAN.md §8). Accountability does not need them: entries name the
-- staff member by id, and the current name and phone live in app.staff, where they can be changed
-- or erased. The failed-PIN counter changes on every wrong attempt; those are recorded as events
-- by the PIN code (A8), not as row changes.
SELECT private.secure_tenant_table('app.roles');
--> statement-breakpoint
SELECT private.secure_tenant_table('app.role_permissions');
--> statement-breakpoint
SELECT private.secure_tenant_table(
  'app.staff',
  p_ignore => ARRAY['pin_failed_count'],
  p_redact => ARRAY['pin_hash', 'invite_token_hash', 'phone', 'invite_email']
);
--> statement-breakpoint
SELECT private.secure_tenant_table('app.staff_sessions');
