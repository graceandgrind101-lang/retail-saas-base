import { describe, expect, it } from "vitest";
import {
  ALERT_CATEGORIES,
  ALERT_RULES,
  ALERT_RULE_KEY_FORMAT,
  ALERT_STATUSES,
  canTransitionAlert,
  isAlertOpen,
  isAlertRuleKey,
} from "./alerts";

describe("alert rules", () => {
  it("every rule key fits the database's format and has a known category and a severity of 1 to 5", () => {
    for (const [key, rule] of Object.entries(ALERT_RULES)) {
      expect(key).toMatch(ALERT_RULE_KEY_FORMAT);
      expect(ALERT_CATEGORIES as readonly string[]).toContain(rule.category);
      expect([1, 2, 3, 4, 5]).toContain(rule.severity);
    }
  });

  it("the PIN lockout rules are suspicion alerts, and a locked till is worse than a locked person", () => {
    expect(ALERT_RULES["pin.staff_locked"]).toEqual({ category: "suspicion", severity: 3 });
    expect(ALERT_RULES["pin.device_locked"]).toEqual({ category: "suspicion", severity: 4 });
  });

  it("knows its own keys only (not inherited object names)", () => {
    expect(isAlertRuleKey("pin.staff_locked")).toBe(true);
    for (const key of ["", "pin", "toString", "constructor", "__proto__", "hasOwnProperty", "pin.nope"]) {
      expect(isAlertRuleKey(key), key).toBe(false);
    }
  });

  it("the key format refuses malformed keys", () => {
    for (const key of ["pin", "Pin.locked", "pin.", ".locked", "pin locked", "pin..locked", ""]) {
      expect(ALERT_RULE_KEY_FORMAT.test(key), key).toBe(false);
    }
    expect(ALERT_RULE_KEY_FORMAT.test("sale.below_floor")).toBe(true);
  });
});

describe("the life cycle", () => {
  it("allows exactly: new to ack, resolved or dismissed; ack to resolved or dismissed", () => {
    const allowed: string[] = [];
    for (const from of ALERT_STATUSES) {
      for (const to of ALERT_STATUSES) if (canTransitionAlert(from, to)) allowed.push(`${from}>${to}`);
    }
    expect(allowed.sort()).toEqual(["ack>dismissed", "ack>resolved", "new>ack", "new>dismissed", "new>resolved"]);
  });

  it("a closed alert is final", () => {
    for (const to of ALERT_STATUSES) {
      expect(canTransitionAlert("resolved", to)).toBe(false);
      expect(canTransitionAlert("dismissed", to)).toBe(false);
    }
  });

  it("new and ack are open, closed ones are not", () => {
    expect(ALERT_STATUSES.filter(isAlertOpen)).toEqual(["new", "ack"]);
  });
});
