-- 0014_setting_functions (hand-written; Phase A task A14, PLAN.md §4, docs/DATA_MODEL.md)
--
-- Saving a setting, and what a shop is allowed to do with each one.
--
--   * app.set_setting is the ONLY way a shop writes app.tenant_settings (a direct write from the
--     shop's own login is refused by the same guard as the permission tables). It needs
--     settings:edit, and it refuses:
--       - a setting that is not 'editable': the shop's own policy row, else the platform-wide one,
--         else the launch state the caller read from core's registry (RT010). A locked setting
--         cannot be saved however the request was made;
--       - a SENSITIVE setting unless this transaction holds a PIN approval for settings:edit that
--         the same person typed (RT011).
--     The caller (our server code) passes the registry's default state and the sensitive flag, the
--     same trust the other functions give it; the browser never reaches this function directly.
--   * Every save is a row change in the audit log with who made it (the table is audited).
--   * app.my_setting_policies shows a shop which of its settings have an explicit policy (the
--     platform schema is closed to shops).
--
-- Custom error codes: RT010 setting is not editable, RT011 a PIN approval is needed.
--
-- Rules for this file (see migration 0001): statements are separated by Drizzle's breakpoint
-- marker, which must never appear inside a comment or a string.

CREATE FUNCTION app.set_setting(p_key text, p_value jsonb, p_default_state text, p_sensitive boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tenant uuid := private.ctx_tenant();
  v_staff  uuid := private.ctx_staff();
  v_state  text;
  v_pin    uuid := private.ctx_pin_verification();
BEGIN
  PERFORM private.assert_permission('settings:edit');
  IF p_default_state NOT IN ('editable', 'locked', 'hidden') THEN
    RAISE EXCEPTION 'unknown default state' USING ERRCODE = 'check_violation';
  END IF;

  SELECT coalesce(
           (SELECT t.state::text FROM platform.setting_policies t WHERE t.tenant_id = v_tenant AND t.key = p_key),
           (SELECT g.state::text FROM platform.setting_policies g WHERE g.tenant_id IS NULL AND g.key = p_key),
           p_default_state)
    INTO v_state;
  IF v_state <> 'editable' THEN
    RAISE EXCEPTION 'this setting is not editable' USING ERRCODE = 'RT010';
  END IF;

  IF p_sensitive THEN
    IF v_pin IS NULL OR NOT EXISTS (
      SELECT 1 FROM app.pin_verifications v
      WHERE v.tenant_id = v_tenant AND v.id = v_pin AND v.staff_id = v_staff AND v.requested_by = v_staff AND v.action_key = 'settings:edit'
    ) THEN
      RAISE EXCEPTION 'this setting needs your PIN' USING ERRCODE = 'RT011';
    END IF;
  END IF;

  INSERT INTO app.tenant_settings (id, tenant_id, created_by, key, value, updated_by)
  VALUES (gen_random_uuid(), v_tenant, v_staff, p_key, p_value, v_staff)
  ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by;
END
$$;
--> statement-breakpoint

CREATE FUNCTION app.my_setting_policies() RETURNS TABLE (key text, tenant_state text, platform_state text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT k.key,
         (SELECT t.state::text FROM platform.setting_policies t WHERE t.tenant_id = private.ctx_tenant() AND t.key = k.key),
         (SELECT g.state::text FROM platform.setting_policies g WHERE g.tenant_id IS NULL AND g.key = k.key)
  FROM (SELECT DISTINCT p.key FROM platform.setting_policies p WHERE p.tenant_id IS NULL OR p.tenant_id = private.ctx_tenant()) k
  ORDER BY k.key
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION app.set_setting(text, jsonb, text, boolean), app.my_setting_policies() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.set_setting(text, jsonb, text, boolean), app.my_setting_policies() TO authenticated;
--> statement-breakpoint

CREATE TRIGGER guard_permission_writes BEFORE INSERT OR UPDATE OR DELETE ON app.tenant_settings
  FOR EACH ROW EXECUTE FUNCTION private.guard_permission_writes();
--> statement-breakpoint

SELECT private.secure_tenant_table('app.tenant_settings');
