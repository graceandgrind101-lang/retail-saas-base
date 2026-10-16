import { describe, expect, it } from "vitest";
import { ACTIVITY_KINDS, describeActivity, type ActivityInput } from "./activity";

const entry = (over: Partial<ActivityInput>): ActivityInput => ({ eventKey: "row.update", tableName: null, before: null, after: null, ...over });
const kind = (over: Partial<ActivityInput>) => describeActivity(entry(over)).kind;
const hidden = (over: Partial<ActivityInput>) => describeActivity(entry(over)).hidden;

describe("events that are not row changes", () => {
  it("names the shop's creation, an accepted invitation and the PIN lockouts", () => {
    expect(kind({ eventKey: "tenant.created" })).toBe("shopCreated");
    expect(kind({ eventKey: "staff.invite_accepted" })).toBe("staffAcceptedInvite");
    expect(kind({ eventKey: "pin.staff_locked" })).toBe("pinStaffLocked");
    expect(kind({ eventKey: "pin.device_locked" })).toBe("pinDeviceLocked");
    for (const e of ["tenant.created", "staff.invite_accepted", "pin.staff_locked", "pin.device_locked"]) expect(hidden({ eventKey: e })).toBe(false);
  });
});

describe("people", () => {
  const staff = "app.staff";
  it("added, role changed, suspended, reinstated, archived, PIN set, other edits", () => {
    expect(kind({ tableName: staff, eventKey: "row.insert" })).toBe("staffAdded");
    expect(kind({ tableName: staff, after: { role_id: "x" }, before: { role_id: "y" } })).toBe("staffRoleChanged");
    expect(kind({ tableName: staff, after: { status: "suspended" }, before: { status: "active" } })).toBe("staffSuspended");
    expect(kind({ tableName: staff, after: { status: "archived" }, before: { status: "active" } })).toBe("staffArchived");
    expect(kind({ tableName: staff, after: { status: "active" }, before: { status: "suspended" } })).toBe("staffReinstated");
    expect(kind({ tableName: staff, after: { pin_hash: "[redacted]" }, before: { pin_hash: "[redacted]" } })).toBe("staffPinSet");
    expect(kind({ tableName: staff, after: { display_name: "New" }, before: { display_name: "Old" } })).toBe("staffUpdated");
  });

  it("a role change wins when several columns changed at once", () => {
    expect(kind({ tableName: staff, after: { role_id: "x", status: "suspended" } })).toBe("staffRoleChanged");
  });

  it("an invitation being accepted is shown once (the row change is hidden; its own event is shown)", () => {
    const row = entry({ tableName: staff, after: { status: "active", auth_user_id: "a" }, before: { status: "invited", auth_user_id: null } });
    expect(describeActivity(row)).toMatchObject({ kind: "staffAcceptedInvite", hidden: true });
    // but an ordinary reinstatement is not
    expect(hidden({ tableName: staff, after: { status: "active" }, before: { status: "suspended" } })).toBe(false);
  });

  it("a lock being set or cleared on a person is plumbing (the lock has its own entry)", () => {
    expect(hidden({ tableName: staff, after: { pin_locked_until: "2026-01-01" }, before: { pin_locked_until: null } })).toBe(true);
  });

  it("a deletion or an unknown status is not given a wrong sentence", () => {
    expect(kind({ tableName: staff, eventKey: "row.delete" })).toBe("other");
    expect(kind({ tableName: staff, after: { status: "weird" } })).toBe("staffUpdated");
  });
});

describe("sign-ins, devices and codes", () => {
  it("a sign-in is shown with how it was done; its ending is plumbing", () => {
    expect(describeActivity(entry({ tableName: "app.staff_sessions", eventKey: "row.insert", after: { method: "pin" } }))).toMatchObject({ kind: "signedIn", hidden: false, params: { method: "pin" } });
    expect(hidden({ tableName: "app.staff_sessions", eventKey: "row.update" })).toBe(true);
  });

  it("devices: connected, disconnected, unlocked; a lock being set is plumbing", () => {
    expect(kind({ tableName: "app.devices", eventKey: "row.insert" })).toBe("deviceConnected");
    expect(kind({ tableName: "app.devices", after: { revoked_at: "2026-01-01" } })).toBe("deviceRevoked");
    expect(kind({ tableName: "app.devices", after: { pin_locked_until: null }, before: { pin_locked_until: "2026-01-01" } })).toBe("deviceUnlocked");
    expect(hidden({ tableName: "app.devices", after: { pin_locked_until: "2026-01-01" } })).toBe(true);
    expect(kind({ tableName: "app.devices", after: { name: "Counter 2" } })).toBe("deviceUpdated");
    expect(hidden({ tableName: "app.devices", after: { name: "Counter 2" } })).toBe(false);
  });

  it("a pairing code made is shown; its use is plumbing", () => {
    expect(kind({ tableName: "app.device_pairing_codes", eventKey: "row.insert" })).toBe("pairingCodeMade");
    expect(hidden({ tableName: "app.device_pairing_codes", eventKey: "row.insert" })).toBe(false);
    expect(hidden({ tableName: "app.device_pairing_codes", eventKey: "row.update" })).toBe(true);
  });
});

describe("settings, alerts, permissions", () => {
  it("a setting saved or changed", () => {
    expect(kind({ tableName: "app.tenant_settings", eventKey: "row.insert" })).toBe("settingChanged");
    expect(kind({ tableName: "app.tenant_settings", eventKey: "row.update" })).toBe("settingChanged");
  });

  it("alerts: raised (with the rule), seen, closed (with how); other changes are plumbing", () => {
    expect(describeActivity(entry({ tableName: "app.alerts", eventKey: "row.insert", after: { rule_key: "pin.staff_locked" } }))).toMatchObject({ kind: "alertRaised", params: { ruleKey: "pin.staff_locked" } });
    expect(kind({ tableName: "app.alerts", after: { status: "ack" } })).toBe("alertSeen");
    expect(describeActivity(entry({ tableName: "app.alerts", after: { status: "resolved" } }))).toMatchObject({ kind: "alertClosed", params: { status: "resolved" } });
    expect(describeActivity(entry({ tableName: "app.alerts", after: { status: "dismissed" } }))).toMatchObject({ kind: "alertClosed", params: { status: "dismissed" } });
    expect(hidden({ tableName: "app.alerts", after: { assignee_staff_id: "x" } })).toBe(true);
  });

  it("personal exceptions set or removed, and role permissions changed", () => {
    expect(kind({ tableName: "app.staff_permission_overrides", eventKey: "row.insert" })).toBe("overrideSet");
    expect(kind({ tableName: "app.staff_permission_overrides", eventKey: "row.update" })).toBe("overrideSet");
    expect(kind({ tableName: "app.staff_permission_overrides", eventKey: "row.delete" })).toBe("overrideRemoved");
    expect(kind({ tableName: "app.role_permissions", eventKey: "row.insert" })).toBe("rolePermissionChanged");
    expect(kind({ tableName: "app.role_permissions", eventKey: "row.delete" })).toBe("rolePermissionChanged");
  });
});

describe("anything else", () => {
  it("is 'something changed', never a wrong sentence, and never throws", () => {
    expect(kind({ tableName: "app.branches", eventKey: "row.update" })).toBe("other");
    expect(kind({ tableName: null, eventKey: "something.else" })).toBe("other");
    expect(kind({ tableName: "app.alerts", eventKey: "row.delete" })).toBe("other");
    expect(() => describeActivity({ eventKey: "", tableName: "", before: {}, after: {} })).not.toThrow();
  });

  it("every kind it can return is in the list the messages must cover", () => {
    const seen = new Set<string>();
    const tables = ["app.staff", "app.staff_sessions", "app.devices", "app.device_pairing_codes", "app.tenant_settings", "app.alerts", "app.staff_permission_overrides", "app.role_permissions", "app.branches", null];
    const afters = [null, { role_id: "x" }, { status: "suspended" }, { status: "archived" }, { status: "active" }, { pin_hash: "x" }, { revoked_at: "x" }, { pin_locked_until: null }, { status: "ack" }, { status: "resolved" }, { rule_key: "a.b" }];
    for (const eventKey of ["row.insert", "row.update", "row.delete", "tenant.created", "staff.invite_accepted", "pin.staff_locked", "pin.device_locked"]) {
      for (const tableName of tables) for (const after of afters) seen.add(describeActivity({ eventKey, tableName, before: null, after }).kind);
    }
    for (const k of seen) expect(ACTIVITY_KINDS as readonly string[], k).toContain(k);
    expect(seen.size).toBe(ACTIVITY_KINDS.length);
  });
});
