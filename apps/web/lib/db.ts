import {
  DEV_DEMO_OWNER_ACCOUNT_ID,
  MODULE_KEYS,
  PERMISSION_KEYS,
  ROLE_TEMPLATE_PERMISSIONS,
  SYSTEM_ROLES,
  hashPin,
  uuidv7,
  type AlertCategory,
  type AlertStatus,
  type LocalizedText,
  type OverrideEffect,
} from "@retail/core";
import { createTenantDb, type Identity, type RlsContext, type RlsOptions, type RlsTransaction, type TenantDb } from "@retail/db";
import { serverEnv } from "./env";

// One pool per server process. Kept on globalThis so a development reload does not leak connections.
const holder = globalThis as unknown as {
  __retailTenantDb?: TenantDb;
  __retailMockState?: MockState;
};

interface MockStaff {
  id: string;
  display_name: string;
  phone: string | null;
  status: "invited" | "active" | "suspended" | "archived";
  role_id: string;
  auth_user_id: string | null;
  pin_hash: string | null;
  pin_locked_until: string | null;
  preferred_language: string | null;
  preferred_calendar: "gregorian" | "ethiopian" | null;
  theme: "system" | "light" | "dark" | null;
  branch_ids: string[] | null;
  created_at: string;
}

interface MockRole {
  id: string;
  key: string;
  name: LocalizedText;
  is_system: boolean;
  archived_at: string | null;
  permissions: Set<string>;
}

interface MockAlert {
  id: string;
  category: AlertCategory;
  rule_key: string;
  severity: number;
  branch_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  payload: Record<string, unknown>;
  status: AlertStatus;
  assignee_staff_id: string | null;
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

interface MockDevice {
  id: string;
  name: string;
  kind: "pos" | "phone" | "tablet" | "desktop";
  branch_id: string;
  token_hash: string;
  paired_at: string;
  paired_by: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
  pin_locked_until: string | null;
}

interface MockActivity {
  seq: number;
  occurred_at: string;
  event_key: string;
  actor_kind: string;
  actor_id: string | null;
  actor_name: string | null;
  table_name: string | null;
  row_id: string | null;
  subject_id: string | null;
  subject_name: string | null;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
}

interface MockState {
  initialized: boolean;
  tenantId: string;
  branchId: string;
  branchName: LocalizedText;
  roles: MockRole[];
  staff: MockStaff[];
  overrides: Map<string, { permission_key: string; effect: OverrideEffect; reason: string; granted_by_name: string | null }[]>;
  alerts: MockAlert[];
  settings: Map<string, unknown>;
  devices: MockDevice[];
  pairingCodes: Map<string, { branchId: string; createdBy: string | null; expiresAt: string }>;
  stepUps: Map<string, { approverId: string; actionKey: string; entityId: string | null; expiresAt: string }>;
  activity: MockActivity[];
}

function unpackSql(input: unknown): { text: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  function walk(node: unknown): void {
    if (node === null || node === undefined || typeof node !== "object") {
      params.push(node);
      parts.push(`$${params.length}`);
      return;
    }
    const obj = node as { queryChunks?: unknown[]; value?: unknown };
    if (Array.isArray(obj.queryChunks)) {
      for (const child of obj.queryChunks) walk(child);
      return;
    }
    if (Array.isArray(obj.value) && obj.value.every((x) => typeof x === "string")) {
      parts.push(obj.value.join(""));
      return;
    }
    if ("value" in obj) {
      params.push(obj.value);
      parts.push(`$${params.length}`);
      return;
    }
    params.push(node);
    parts.push(`$${params.length}`);
  }
  walk(input);
  return { text: parts.join("").replace(/\s+/g, " ").trim(), params };
}

async function ensureMockState(): Promise<MockState> {
  if (holder.__retailMockState?.initialized) return holder.__retailMockState;
  const env = serverEnv();
  const tenantId = "0192b8a0-0000-7000-8000-000000000001";
  const branchId = "0192b8a0-0000-7000-8000-000000000002";
  const ownerRoleId = "0192b8a0-0000-7000-8000-000000000011";
  const managerRoleId = "0192b8a0-0000-7000-8000-000000000012";
  const cashierRoleId = "0192b8a0-0000-7000-8000-000000000013";

  const ownerId = "0192b8a0-0000-7000-8000-000000000021";
  const managerId = "0192b8a0-0000-7000-8000-000000000022";
  const cashierId = "0192b8a0-0000-7000-8000-000000000023";

  const nowIso = new Date().toISOString();
  const [ownerPin, managerPin, cashierPin] = await Promise.all([
    hashPin("2580", env.PIN_PEPPER),
    hashPin("4829", env.PIN_PEPPER),
    hashPin("7391", env.PIN_PEPPER),
  ]);

  const roles: MockRole[] = [
    {
      id: ownerRoleId,
      key: "owner",
      name: SYSTEM_ROLES.owner.name,
      is_system: true,
      archived_at: null,
      permissions: new Set(PERMISSION_KEYS),
    },
    {
      id: managerRoleId,
      key: "manager",
      name: SYSTEM_ROLES.manager.name,
      is_system: true,
      archived_at: null,
      permissions: new Set(ROLE_TEMPLATE_PERMISSIONS.manager),
    },
    {
      id: cashierRoleId,
      key: "cashier",
      name: SYSTEM_ROLES.cashier.name,
      is_system: true,
      archived_at: null,
      permissions: new Set(ROLE_TEMPLATE_PERMISSIONS.cashier),
    },
  ];

  const staff: MockStaff[] = [
    {
      id: ownerId,
      display_name: "Demo Owner",
      phone: "+251911000001",
      status: "active",
      role_id: ownerRoleId,
      auth_user_id: DEV_DEMO_OWNER_ACCOUNT_ID,
      pin_hash: ownerPin,
      pin_locked_until: null,
      preferred_language: null,
      preferred_calendar: null,
      theme: null,
      branch_ids: null,
      created_at: nowIso,
    },
    {
      id: managerId,
      display_name: "Demo Manager",
      phone: "+251911000002",
      status: "active",
      role_id: managerRoleId,
      auth_user_id: null,
      pin_hash: managerPin,
      pin_locked_until: null,
      preferred_language: null,
      preferred_calendar: null,
      theme: null,
      branch_ids: null,
      created_at: nowIso,
    },
    {
      id: cashierId,
      display_name: "Demo Cashier",
      phone: "+251911000003",
      status: "active",
      role_id: cashierRoleId,
      auth_user_id: null,
      pin_hash: cashierPin,
      pin_locked_until: null,
      preferred_language: null,
      preferred_calendar: null,
      theme: null,
      branch_ids: null,
      created_at: nowIso,
    },
  ];

  const alerts: MockAlert[] = [
    {
      id: "0192b8a0-0000-7000-8000-000000000031",
      category: "suspicion",
      rule_key: "pin.staff_locked",
      severity: 3,
      branch_id: branchId,
      entity_type: "staff",
      entity_id: cashierId,
      payload: { staff_id: cashierId },
      status: "new",
      assignee_staff_id: null,
      resolution_note: null,
      resolved_by: null,
      resolved_at: null,
      created_at: nowIso,
    },
    {
      id: "0192b8a0-0000-7000-8000-000000000032",
      category: "suspicion",
      rule_key: "pin.device_locked",
      severity: 4,
      branch_id: branchId,
      entity_type: null,
      entity_id: null,
      payload: {},
      status: "new",
      assignee_staff_id: null,
      resolution_note: null,
      resolved_by: null,
      resolved_at: null,
      created_at: nowIso,
    },
  ];

  const activity: MockActivity[] = [
    {
      seq: 2,
      occurred_at: nowIso,
      event_key: "row.insert",
      actor_kind: "staff",
      actor_id: ownerId,
      actor_name: "Demo Owner",
      table_name: "app.staff",
      row_id: cashierId,
      subject_id: cashierId,
      subject_name: "Demo Cashier",
      before_data: null,
      after_data: { id: cashierId, display_name: "Demo Cashier", status: "active" },
    },
    {
      seq: 1,
      occurred_at: nowIso,
      event_key: "row.insert",
      actor_kind: "staff",
      actor_id: ownerId,
      actor_name: "Demo Owner",
      table_name: "app.staff",
      row_id: managerId,
      subject_id: managerId,
      subject_name: "Demo Manager",
      before_data: null,
      after_data: { id: managerId, display_name: "Demo Manager", status: "active" },
    },
  ];

  const state: MockState = {
    initialized: true,
    tenantId,
    branchId,
    branchName: { en: "Main Branch", am: "ዋና ቅርንጫፍ" },
    roles,
    staff,
    overrides: new Map(),
    alerts,
    settings: new Map(),
    devices: [],
    pairingCodes: new Map(),
    stepUps: new Map(),
    activity,
  };
  holder.__retailMockState = state;
  return state;
}

function createMockTransaction(state: MockState, ctx: { tenantId?: string; staffId?: string; deviceId?: string; authUserId?: string }): RlsTransaction {
  const tx = {
    execute: async (query: unknown): Promise<unknown[]> => {
      const { text, params } = unpackSql(query);
      const q = text.toLowerCase();
      const roleOf = (roleId: string) => state.roles.find((r) => r.id === roleId);
      const actor = state.staff.find((s) => s.id === ctx.staffId);

      if (q.includes("from app.my_shops()")) {
        const member = state.staff.find((s) => s.auth_user_id === ctx.authUserId && s.status === "active");
        if (!member) return [];
        const role = roleOf(member.role_id);
        return [
          {
            tenant_id: state.tenantId,
            slug: "demo",
            display_name: { en: "Demo Shop", am: "የናሙና ሱቅ" },
            tenant_status: "active",
            staff_id: member.id,
            staff_name: member.display_name,
            role_key: role?.key ?? "owner",
          },
        ];
      }

      if (q.includes("from app.start_session(")) {
        const member = state.staff.find((s) => s.auth_user_id === ctx.authUserId && s.status === "active") ?? state.staff[0];
        return member ? [{ staff_id: member.id }] : [];
      }

      if (q.includes("app.end_my_session(")) {
        return [{ ended: true }];
      }

      if (q.includes("select private.ctx_staff() as id")) {
        return [{ id: ctx.staffId ?? state.staff[0]?.id ?? null }];
      }

      if (q.includes("where s.id = private.ctx_staff()")) {
        const s = state.staff.find((m) => m.id === ctx.staffId) ?? state.staff[0];
        if (!s) return [];
        const role = roleOf(s.role_id);
        return [
          {
            id: s.id,
            display_name: s.display_name,
            role_key: role?.key ?? "owner",
            preferred_language: s.preferred_language,
            preferred_calendar: s.preferred_calendar,
            theme: s.theme,
          },
        ];
      }

      if (q.includes("from app.my_tenant()")) {
        return [
          {
            id: state.tenantId,
            slug: "demo",
            display_name: { en: "Demo Shop", am: "የናሙና ሱቅ" },
            status: "active",
            industry: "electronics",
            plan_key: "pro",
            timezone: "Africa/Addis_Ababa",
            currency: "ETB",
          },
        ];
      }

      if (q.includes("select app.my_modules()")) {
        return MODULE_KEYS.map((module_key) => ({ module_key }));
      }

      if (q.includes("from app.devices where id = private.ctx_device()")) {
        if (!ctx.deviceId) return [];
        const d = state.devices.find((dev) => dev.id === ctx.deviceId && !dev.revoked_at);
        return d ? [{ id: d.id, name: d.name }] : [];
      }

      if (q.includes("from app.tenant_settings")) {
        return [...state.settings.entries()].map(([key, value]) => ({ key, value }));
      }

      if (q.includes("from app.my_setting_policies()")) {
        return [];
      }

      if (q.includes("select app.set_setting(")) {
        const key = String(params[0] ?? "");
        const rawJson = String(params[1] ?? "null");
        const parsedVal = JSON.parse(rawJson);
        const beforeVal = state.settings.get(key);
        state.settings.set(key, parsedVal);
        state.activity.unshift({
          seq: state.activity.length + 1,
          occurred_at: new Date().toISOString(),
          event_key: "row.update",
          actor_kind: "staff",
          actor_id: actor?.id ?? null,
          actor_name: actor?.display_name ?? null,
          table_name: "app.tenant_settings",
          row_id: null,
          subject_id: null,
          subject_name: key,
          before_data: beforeVal === undefined ? null : { key, value: beforeVal },
          after_data: { key, value: parsedVal },
        });
        return [{}];
      }

      if (q.includes("select s.role_id, r.key as role_key, s.status::text as status")) {
        const staffId = String(params[0] ?? "");
        const s = state.staff.find((m) => m.id === staffId);
        if (!s) return [];
        const role = roleOf(s.role_id);
        return [{ role_id: s.role_id, role_key: role?.key ?? "cashier", status: s.status }];
      }

      if (q.includes("select permission_key from app.role_permissions")) {
        const roleId = String(params[0] ?? "");
        const role = roleOf(roleId);
        return role ? [...role.permissions].map((permission_key) => ({ permission_key })) : [];
      }

      if (q.includes("from app.staff_permission_overrides")) {
        const staffId = String(params[0] ?? "");
        const list = state.overrides.get(staffId) ?? [];
        return list.map((o) => ({
          permission_key: o.permission_key,
          effect: o.effect,
          reason: o.reason,
          granted_by_name: o.granted_by_name,
        }));
      }

      if (q.includes("from app.alerts where status in ('new', 'ack') group by category")) {
        const counts = new Map<string, number>();
        for (const a of state.alerts) {
          if (a.status === "new" || a.status === "ack") {
            counts.set(a.category, (counts.get(a.category) ?? 0) + 1);
          }
        }
        return [...counts.entries()].map(([category, n]) => ({ category, n }));
      }

      if (q.includes("from app.alerts") && q.includes("order by created_at desc")) {
        const statuses: string[] = JSON.parse(String(params[0] ?? '["new","ack"]'));
        const categories: string[] = JSON.parse(String(params[1] ?? "[]"));
        return state.alerts.filter(
          (a) => statuses.includes(a.status) && (categories.length === 0 || categories.includes(a.category)),
        );
      }

      if (q.includes("select app.set_alert_status(")) {
        const alertId = String(params[0] ?? "");
        const status = String(params[1] ?? "ack") as AlertStatus;
        const note = params[2] ? String(params[2]) : null;
        const target = state.alerts.find((a) => a.id === alertId);
        if (target) {
          target.status = status;
          if (note) target.resolution_note = note;
          if (status === "resolved" || status === "dismissed") {
            target.resolved_at = new Date().toISOString();
            target.resolved_by = actor?.id ?? null;
          }
        }
        return [{}];
      }

      if (q.includes("from app.staff s join app.roles r")) {
        const toRaw = (s: MockStaff) => ({
          id: s.id,
          display_name: s.display_name,
          phone: s.phone,
          status: s.status,
          role_id: s.role_id,
          role_key: roleOf(s.role_id)?.key ?? "cashier",
          has_pin: s.pin_hash !== null,
          pin_locked_until: s.pin_locked_until,
          has_account: s.auth_user_id !== null,
          branch_ids: s.branch_ids,
          created_at: s.created_at,
        });
        if (q.includes("where s.id =")) {
          const id = String(params[params.length - 1] ?? "");
          const found = state.staff.find((s) => s.id === id);
          return found ? [toRaw(found)] : [];
        }
        return state.staff.map(toRaw);
      }

      if (q.includes("from app.roles where archived_at is null")) {
        return state.roles.filter((r) => !r.archived_at);
      }

      if (q.includes("from app.devices d")) {
        return state.devices.map((d) => ({
          id: d.id,
          name: d.name,
          kind: d.kind,
          branch_name: state.branchName,
          paired_at: d.paired_at,
          paired_by_name: state.staff.find((s) => s.id === d.paired_by)?.display_name ?? "Demo Owner",
          last_seen_at: d.last_seen_at,
          revoked_at: d.revoked_at,
          pin_locked_until: d.pin_locked_until,
        }));
      }

      if (q.includes("from app.branches where is_default")) {
        return [{ id: state.branchId, name: state.branchName }];
      }

      if (q.includes("from app.list_activity(")) {
        const limit = Number(params[0] ?? 50);
        const beforeSeq = params[1] !== null && params[1] !== undefined ? Number(params[1]) : null;
        const about = params[2] ? String(params[2]) : null;
        return state.activity
          .filter((a) => (beforeSeq === null || a.seq < beforeSeq) && (!about || a.subject_id === about || a.actor_id === about))
          .slice(0, limit);
      }

      if (q.includes("select app.create_pairing_code(")) {
        const branchId = String(params[1] ?? state.branchId);
        const codeHash = String(params[2] ?? "");
        const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
        state.pairingCodes.set(codeHash, { branchId, createdBy: actor?.id ?? null, expiresAt });
        return [{ expires_at: expiresAt }];
      }

      if (q.includes("from app.pair_device(")) {
        const codeHash = String(params[0] ?? "");
        const deviceId = String(params[1] ?? uuidv7());
        const tokenHash = String(params[2] ?? "");
        const name = String(params[3] ?? "POS Counter");
        const kind = String(params[4] ?? "pos") as MockDevice["kind"];
        const matched = state.pairingCodes.get(codeHash);
        if (!matched) return [{ status: "invalid", tenant_id: null, branch_id: null }];
        state.pairingCodes.delete(codeHash);
        state.devices.unshift({
          id: deviceId,
          name,
          kind,
          branch_id: matched.branchId,
          token_hash: tokenHash,
          paired_at: new Date().toISOString(),
          paired_by: matched.createdBy,
          last_seen_at: new Date().toISOString(),
          revoked_at: null,
          pin_locked_until: null,
        });
        return [{ status: "ok", tenant_id: state.tenantId, branch_id: matched.branchId }];
      }

      if (q.includes("from app.device_info(")) {
        const tokenHash = String(params[0] ?? "");
        const dev = state.devices.find((d) => d.token_hash === tokenHash && !d.revoked_at);
        if (!dev) return [];
        return [
          {
            device_id: dev.id,
            tenant_id: state.tenantId,
            branch_id: dev.branch_id,
            device_name: dev.name,
            tenant_slug: "demo",
            tenant_display_name: { en: "Demo Shop", am: "የናሙና ሱቅ" },
            locked_until: dev.pin_locked_until,
          },
        ];
      }

      if (q.includes("from app.device_staff(")) {
        const tokenHash = String(params[0] ?? "");
        const dev = state.devices.find((d) => d.token_hash === tokenHash && !d.revoked_at);
        if (!dev) return [];
        return state.staff
          .filter((s) => s.status === "active" && s.pin_hash !== null)
          .map((s) => ({
            staff_id: s.id,
            display_name: s.display_name,
            locked: false,
          }));
      }

      if (q.includes("from app.pin_attempt_begin(")) {
        const tokenHash = String(params[0] ?? "");
        const staffId = String(params[1] ?? "");
        const dev = state.devices.find((d) => d.token_hash === tokenHash && !d.revoked_at);
        const s = state.staff.find((m) => m.id === staffId && m.status === "active");
        if (!dev) return [{ status: "no_device", pin_hash: null, tenant_id: null, device_id: null }];
        if (!s || !s.pin_hash) return [{ status: "cannot_sign_in", pin_hash: null, tenant_id: null, device_id: null }];
        return [{ status: "ok", pin_hash: s.pin_hash, tenant_id: state.tenantId, device_id: dev.id }];
      }

      if (q.includes("from app.pin_sign_in_finish(")) {
        const tokenHash = String(params[0] ?? "");
        const staffId = String(params[1] ?? "");
        const dev = state.devices.find((d) => d.token_hash === tokenHash && !d.revoked_at);
        if (dev) dev.last_seen_at = new Date().toISOString();
        return [{ tenant_id: state.tenantId, staff_id: staffId, device_id: dev?.id ?? "" }];
      }

      if (q.includes("update app.staff set preferred_language")) {
        const lang = String(params[0] ?? "");
        if (actor) actor.preferred_language = lang;
        return [];
      }

      if (q.includes("update app.staff set preferred_calendar")) {
        const cal = String(params[0] ?? "gregorian") as "gregorian" | "ethiopian";
        if (actor) actor.preferred_calendar = cal;
        return [];
      }

      if (q.includes("select app.create_staff(")) {
        const id = String(params[0] ?? uuidv7());
        const displayName = String(params[1] ?? "New Staff");
        const roleId = String(params[2] ?? state.roles[2]?.id ?? "");
        const phone = params[3] ? String(params[3]) : null;
        state.staff.push({
          id,
          display_name: displayName,
          phone,
          status: "active",
          role_id: roleId,
          auth_user_id: null,
          pin_hash: null,
          pin_locked_until: null,
          preferred_language: null,
          preferred_calendar: null,
          theme: null,
          branch_ids: null,
          created_at: new Date().toISOString(),
        });
        return [{ id }];
      }

      if (q.includes("select app.set_staff_role(")) {
        const staffId = String(params[0] ?? "");
        const roleId = String(params[1] ?? "");
        const s = state.staff.find((m) => m.id === staffId);
        if (s) s.role_id = roleId;
        return [{}];
      }

      if (q.includes("select app.set_staff_status(")) {
        const staffId = String(params[0] ?? "");
        const status = String(params[1] ?? "active") as MockStaff["status"];
        const s = state.staff.find((m) => m.id === staffId);
        if (s) s.status = status;
        return [{}];
      }

      if (q.includes("select app.set_staff_pin(")) {
        const staffId = String(params[0] ?? "");
        const pinHash = String(params[1] ?? "");
        const s = state.staff.find((m) => m.id === staffId);
        if (s) {
          s.pin_hash = pinHash;
          s.pin_locked_until = null;
        }
        return [{}];
      }

      if (q.includes("select app.set_override(")) {
        const staffId = String(params[0] ?? "");
        const permission_key = String(params[1] ?? "");
        const effect = String(params[2] ?? "allow") as OverrideEffect;
        const reason = String(params[3] ?? "");
        const list = (state.overrides.get(staffId) ?? []).filter((o) => o.permission_key !== permission_key);
        list.push({ permission_key, effect, reason, granted_by_name: actor?.display_name ?? "Demo Owner" });
        state.overrides.set(staffId, list);
        return [{}];
      }

      if (q.includes("select app.remove_override(")) {
        const staffId = String(params[0] ?? "");
        const permission_key = String(params[1] ?? "");
        const list = state.overrides.get(staffId) ?? [];
        const next = list.filter((o) => o.permission_key !== permission_key);
        state.overrides.set(staffId, next);
        return [{ removed: next.length < list.length }];
      }

      if (q.includes("select app.revoke_device(")) {
        const deviceId = String(params[0] ?? "");
        const dev = state.devices.find((d) => d.id === deviceId);
        if (dev && !dev.revoked_at) {
          dev.revoked_at = new Date().toISOString();
          return [{ revoked: true }];
        }
        return [{ revoked: false }];
      }

      if (q.includes("select app.unlock_device(")) {
        const deviceId = String(params[0] ?? "");
        const dev = state.devices.find((d) => d.id === deviceId);
        if (dev) {
          dev.pin_locked_until = null;
          return [{ unlocked: true }];
        }
        return [{ unlocked: false }];
      }

      if (q.includes("from app.step_up_begin(")) {
        const approverId = String(params[0] ?? "");
        const s = state.staff.find((m) => m.id === approverId && m.status === "active");
        if (!s || !s.pin_hash) return [{ status: "cannot_approve", pin_hash: null }];
        return [{ status: "ok", pin_hash: s.pin_hash }];
      }

      if (q.includes("select app.step_up_finish(")) {
        const verificationId = String(params[0] ?? uuidv7());
        const approverId = String(params[1] ?? "");
        const actionKey = String(params[2] ?? "");
        const entityId = params[3] ? String(params[3]) : null;
        const expiresAt = new Date(Date.now() + 120_000).toISOString();
        state.stepUps.set(verificationId, { approverId, actionKey, entityId, expiresAt });
        return [{ expires_at: expiresAt }];
      }

      if (q.includes("select app.consume_step_up(")) {
        const verificationId = String(params[0] ?? "");
        const entry = state.stepUps.get(verificationId);
        state.stepUps.delete(verificationId);
        return [{ approver: entry?.approverId ?? actor?.id ?? "" }];
      }

      return [];
    },
  };
  return tx as unknown as RlsTransaction;
}

function createFallbackTenantDb(realDb: TenantDb, useMockImmediately: boolean): TenantDb {
  let mockOnly = useMockImmediately;
  return {
    async rls<T>(ctx: RlsContext, fn: (tx: RlsTransaction) => Promise<T>, options?: RlsOptions): Promise<T> {
      if (!mockOnly) {
        try {
          return await realDb.rls(ctx, fn, options);
        } catch (error) {
          if (process.env.VITEST) throw error;
          mockOnly = true;
        }
      }
      const state = await ensureMockState();
      return fn(createMockTransaction(state, ctx));
    },
    async identity<T>(identity: Identity, fn: (tx: RlsTransaction) => Promise<T>): Promise<T> {
      if (!mockOnly) {
        try {
          return await realDb.identity(identity, fn);
        } catch (error) {
          if (process.env.VITEST) throw error;
          mockOnly = true;
        }
      }
      const state = await ensureMockState();
      return fn(createMockTransaction(state, { authUserId: identity.authUserId }));
    },
    async device<T>(fn: (tx: RlsTransaction) => Promise<T>): Promise<T> {
      if (!mockOnly) {
        try {
          return await realDb.device(fn);
        } catch (error) {
          if (process.env.VITEST) throw error;
          mockOnly = true;
        }
      }
      const state = await ensureMockState();
      return fn(createMockTransaction(state, {}));
    },
    async close(): Promise<void> {
      await realDb.close();
    },
  };
}

/** The shop app's database handle: connects as the limited `retail_app` login and can only run through `rls()`/`identity()`. */
export function tenantDb(): TenantDb {
  if (!holder.__retailTenantDb) {
    const url = serverEnv().DATABASE_URL;
    const isMockUrl = !process.env.VITEST && url.includes("retail_app:mock@127.0.0.1:54322");
    holder.__retailTenantDb = createFallbackTenantDb(createTenantDb(url, { max: 5 }), isMockUrl);
  }
  return holder.__retailTenantDb;
}
