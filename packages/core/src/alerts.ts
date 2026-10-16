/**
 * Alerts (Phase A task A10, PLAN.md §6.3): things the owner should look at. The categories, the
 * life cycle and the rules that raise them are defined here; the database stores them.
 *
 * A rule fixes its own category and severity, so whoever raises an alert cannot downgrade a
 * fraud signal to a message. Payloads must never hold secrets or personal contact details
 * (alerts are readable by staff and are also recorded in the audit log).
 */
export const ALERT_CATEGORIES = ["fraud", "suspicion", "error", "alert", "message", "info"] as const;
export type AlertCategory = (typeof ALERT_CATEGORIES)[number];

export const ALERT_STATUSES = ["new", "ack", "resolved", "dismissed"] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

/** 1 (note it) to 5 (act now). */
export type AlertSeverity = 1 | 2 | 3 | 4 | 5;

export interface AlertRule {
  category: AlertCategory;
  severity: AlertSeverity;
}

/** The rules that exist so far. Later phases add theirs (below-floor sale, duplicate reference, low stock ...). */
export const ALERT_RULES = {
  "pin.staff_locked": { category: "suspicion", severity: 3 },
  "pin.device_locked": { category: "suspicion", severity: 4 },
} as const satisfies Record<string, AlertRule>;

export type AlertRuleKey = keyof typeof ALERT_RULES;

export function isAlertRuleKey(value: string): value is AlertRuleKey {
  return Object.prototype.hasOwnProperty.call(ALERT_RULES, value);
}

/** The shape the database accepts for any stored rule key. */
export const ALERT_RULE_KEY_FORMAT = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

/** Still needs someone's attention. */
export function isAlertOpen(status: AlertStatus): boolean {
  return status === "new" || status === "ack";
}

/**
 * The life cycle: new, then seen (ack), then resolved or dismissed. A new alert may also be
 * closed straight away. Closed is final: nothing reopens, so the record of what happened stays.
 */
export function canTransitionAlert(from: AlertStatus, to: AlertStatus): boolean {
  switch (from) {
    case "new":
      return to === "ack" || to === "resolved" || to === "dismissed";
    case "ack":
      return to === "resolved" || to === "dismissed";
    default:
      return false;
  }
}
