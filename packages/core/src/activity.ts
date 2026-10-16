/**
 * The owner's Activity timeline (Phase A task A15): turning a row of the audit log into a sentence
 * the shop can read. The audit log stays the record of truth (table, event, what changed); this only
 * decides which sentence fits, from the table, the event and which columns changed. The words come
 * from the message files (`activity.event.<kind>`).
 *
 * It never invents: anything it does not recognise becomes the plain "something changed" kind rather
 * than a wrong sentence.
 */
export const ACTIVITY_KINDS = [
  "shopCreated",
  "staffAdded",
  "staffRoleChanged",
  "staffSuspended",
  "staffReinstated",
  "staffArchived",
  "staffPinSet",
  "staffAcceptedInvite",
  "staffUpdated",
  "signedIn",
  "pinStaffLocked",
  "pinDeviceLocked",
  "deviceConnected",
  "deviceRevoked",
  "deviceUnlocked",
  "deviceUpdated",
  "pairingCodeMade",
  "settingChanged",
  "alertRaised",
  "alertSeen",
  "alertClosed",
  "overrideSet",
  "overrideRemoved",
  "rolePermissionChanged",
  "other",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface ActivityInput {
  eventKey: string;
  tableName: string | null;
  /** For an update: only the columns that changed (old values). */
  before: Record<string, unknown> | null;
  /** For an update: only the columns that changed (new values). */
  after: Record<string, unknown> | null;
}

export interface ActivityDescription {
  kind: ActivityKind;
  /** True for entries that are plumbing, not news (a lock that has its own entry, an invitation's second line). */
  hidden: boolean;
  /** Raw values a sentence may mention; the screen turns codes into words. */
  params: { ruleKey?: string; status?: string; method?: string };
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const has = (data: Record<string, unknown> | null, column: string): boolean => data !== null && Object.prototype.hasOwnProperty.call(data, column);

export function describeActivity({ eventKey, tableName, before, after }: ActivityInput): ActivityDescription {
  const shown = (kind: ActivityKind, params: ActivityDescription["params"] = {}): ActivityDescription => ({ kind, hidden: false, params });
  const hidden = (kind: ActivityKind): ActivityDescription => ({ kind, hidden: true, params: {} });

  switch (eventKey) {
    case "tenant.created":
      return shown("shopCreated");
    case "staff.invite_accepted":
      return shown("staffAcceptedInvite");
    case "pin.staff_locked":
      return shown("pinStaffLocked");
    case "pin.device_locked":
      return shown("pinDeviceLocked");
  }

  const insert = eventKey === "row.insert";
  const update = eventKey === "row.update";
  const remove = eventKey === "row.delete";

  switch (tableName) {
    case "app.staff": {
      if (insert) return shown("staffAdded");
      if (!update) return shown("other");
      if (has(after, "role_id")) return shown("staffRoleChanged");
      if (has(after, "status")) {
        if (str(before?.status) === "invited" && str(after?.status) === "active") return hidden("staffAcceptedInvite"); // has its own entry
        switch (str(after?.status)) {
          case "suspended":
            return shown("staffSuspended");
          case "archived":
            return shown("staffArchived");
          case "active":
            return shown("staffReinstated");
        }
        return shown("staffUpdated");
      }
      if (has(after, "pin_hash")) return shown("staffPinSet");
      if (has(after, "pin_locked_until")) return hidden("staffUpdated"); // the lock has its own entry
      return shown("staffUpdated");
    }
    case "app.staff_sessions":
      return insert ? shown("signedIn", { method: str(after?.method) ?? "" }) : hidden("signedIn");
    case "app.devices": {
      if (insert) return shown("deviceConnected");
      if (!update) return shown("other");
      if (has(after, "revoked_at")) return shown("deviceRevoked");
      if (has(after, "pin_locked_until")) return after?.pin_locked_until === null ? shown("deviceUnlocked") : hidden("deviceUpdated");
      return shown("deviceUpdated");
    }
    case "app.device_pairing_codes":
      return insert ? shown("pairingCodeMade") : hidden("pairingCodeMade");
    case "app.tenant_settings":
      return shown("settingChanged");
    case "app.alerts": {
      if (insert) return shown("alertRaised", { ruleKey: str(after?.rule_key) ?? "" });
      if (!update) return shown("other");
      const status = str(after?.status);
      if (status === "ack") return shown("alertSeen");
      if (status === "resolved" || status === "dismissed") return shown("alertClosed", { status });
      return hidden("other");
    }
    case "app.staff_permission_overrides":
      return remove ? shown("overrideRemoved") : shown("overrideSet");
    case "app.role_permissions":
      return shown("rolePermissionChanged");
    default:
      return shown("other");
  }
}
