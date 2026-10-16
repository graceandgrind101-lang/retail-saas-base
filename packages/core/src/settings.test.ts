import { describe, expect, it } from "vitest";
import {
  SETTINGS,
  SETTING_GROUPS,
  SETTING_KEYS,
  SETTING_KEY_FORMAT,
  effectiveSettingState,
  isSettingKey,
  isValidSettingValue,
  parseSettingValue,
  settingGroupOf,
  settingLabelPath,
  settingName,
  settingValue,
  settingsProblems,
  viewSettings,
  type SettingKey,
} from "./settings";

describe("the registry", () => {
  it("has no problems: well-formed keys, real groups, and defaults that satisfy their own rules", () => {
    expect(settingsProblems()).toEqual([]);
    for (const key of SETTING_KEYS) expect(key).toMatch(SETTING_KEY_FORMAT);
  });

  it("every group has at least one setting", () => {
    for (const group of SETTING_GROUPS) expect(SETTING_KEYS.some((k) => settingGroupOf(k) === group), group).toBe(true);
  });

  it("the plan's locked items are locked: payment accounts, pricing rules, security, the fiscal label", () => {
    for (const key of ["payments.telebirr_number", "payments.cbe_account", "pricing.max_discount_percent", "security.pos_idle_lock_seconds", "receipt.not_fiscal_label"] as const) {
      expect(SETTINGS[key].state, key).toBe("locked");
    }
  });

  it("the plan's editable items are editable: business profile, receipt footer, inventory, language and calendar", () => {
    for (const key of ["business.phone", "business.address", "receipt.footer", "receipt.show_cashier", "inventory.low_stock_threshold", "inventory.expiry_warning_days", "locale.default_language", "locale.default_calendar"] as const) {
      expect(SETTINGS[key].state, key).toBe("editable");
    }
  });

  it("payment accounts are sensitive (a PIN is asked), and so is the shop's phone number", () => {
    const sensitive = SETTING_KEYS.filter((k) => "sensitive" in SETTINGS[k]);
    expect(sensitive.sort()).toEqual(["business.phone", "payments.cbe_account", "payments.telebirr_number"]);
  });

  it("defaults are English and Gregorian (PLAN D22, D23)", () => {
    expect(SETTINGS["locale.default_language"].default).toBe("en");
    expect(SETTINGS["locale.default_calendar"].default).toBe("gregorian");
  });

  it("knows its own keys only", () => {
    expect(isSettingKey("receipt.footer")).toBe(true);
    for (const bad of ["", "receipt", "toString", "constructor", "__proto__", "receipt.nope", "Receipt.footer"]) expect(isSettingKey(bad), bad).toBe(false);
  });

  it("names a setting and its label's message path", () => {
    expect(settingName("receipt.footer")).toBe("footer");
    expect(settingLabelPath("inventory.low_stock_threshold")).toBe("settings.inventory.low_stock_threshold.label");
  });
});

describe("checking a value", () => {
  const ok = (key: SettingKey, value: unknown) => parseSettingValue(key, value).ok;

  it("text: within its length, no spaces at the ends, only text", () => {
    expect(ok("business.phone", "0911 000 000")).toBe(true);
    expect(ok("business.phone", "")).toBe(true);
    expect(ok("business.phone", "x".repeat(32))).toBe(true);
    expect(ok("business.phone", "x".repeat(33))).toBe(false);
    expect(ok("business.phone", " 0911")).toBe(false);
    expect(ok("business.phone", "0911 ")).toBe(false);
    for (const bad of [5, null, undefined, true, {}, []]) expect(ok("business.phone", bad), String(bad)).toBe(false);
  });

  it("localized: language codes with texts, empty ones dropped", () => {
    expect(ok("receipt.footer", {})).toBe(true);
    expect(ok("receipt.footer", { en: "Thank you", am: "አመሰግናለሁ" })).toBe(true);
    expect(parseSettingValue("receipt.footer", { en: "Thank you", am: "" })).toEqual({ ok: true, value: { en: "Thank you" } });
    expect(ok("receipt.footer", { en: "x".repeat(201) })).toBe(false);
    expect(ok("receipt.footer", { "Not A Code": "x" })).toBe(false);
    expect(ok("receipt.footer", { en: " padded " })).toBe(false);
    expect(ok("receipt.footer", { en: 5 })).toBe(false);
    for (const bad of ["text", 5, null, [], ["en"]]) expect(ok("receipt.footer", bad), String(bad)).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`x${String.fromCharCode(97 + i)}`, "t"]));
    expect(ok("receipt.footer", many)).toBe(false);
  });

  it("boolean: true or false only", () => {
    expect(ok("receipt.show_cashier", true)).toBe(true);
    expect(ok("receipt.show_cashier", false)).toBe(true);
    for (const bad of ["true", 1, 0, null, undefined]) expect(ok("receipt.show_cashier", bad), String(bad)).toBe(false);
  });

  it("integer: whole numbers inside the range, both ends included", () => {
    expect(ok("inventory.low_stock_threshold", 0)).toBe(true);
    expect(ok("inventory.low_stock_threshold", 10_000)).toBe(true);
    expect(ok("inventory.low_stock_threshold", -1)).toBe(false);
    expect(ok("inventory.low_stock_threshold", 10_001)).toBe(false);
    expect(ok("inventory.expiry_warning_days", 1)).toBe(true);
    expect(ok("inventory.expiry_warning_days", 0)).toBe(false);
    expect(ok("inventory.expiry_warning_days", 365)).toBe(true);
    expect(ok("inventory.expiry_warning_days", 366)).toBe(false);
    for (const bad of [1.5, "5", Number.NaN, Number.POSITIVE_INFINITY, null]) expect(ok("inventory.low_stock_threshold", bad), String(bad)).toBe(false);
  });

  it("enum: only the listed options", () => {
    expect(ok("locale.default_calendar", "ethiopian")).toBe(true);
    expect(ok("locale.default_calendar", "gregorian")).toBe(true);
    for (const bad of ["julian", "Ethiopian", "", 1, null]) expect(ok("locale.default_calendar", bad), String(bad)).toBe(false);
  });

  it("language: a language code", () => {
    expect(ok("locale.default_language", "am")).toBe(true);
    expect(ok("locale.default_language", "pt-BR")).toBe(true);
    for (const bad of ["", "english", "EN", "en_GB", 5, null]) expect(ok("locale.default_language", bad), String(bad)).toBe(false);
  });

  it("isValidSettingValue is the same check", () => {
    expect(isValidSettingValue("receipt.show_cashier", true)).toBe(true);
    expect(isValidSettingValue("receipt.show_cashier", "yes")).toBe(false);
  });
});

describe("what a setting may be done with", () => {
  it("the shop's own policy beats the platform's, which beats the launch state", () => {
    expect(effectiveSettingState("receipt.footer", {})).toBe("editable");
    expect(effectiveSettingState("receipt.footer", { platform: "locked" })).toBe("locked");
    expect(effectiveSettingState("receipt.footer", { platform: "locked", tenant: "editable" })).toBe("editable");
    expect(effectiveSettingState("receipt.footer", { platform: "hidden", tenant: "locked" })).toBe("locked");
    expect(effectiveSettingState("payments.cbe_account", {})).toBe("locked");
    expect(effectiveSettingState("payments.cbe_account", { tenant: "editable" })).toBe("editable");
    expect(effectiveSettingState("receipt.footer", { tenant: null, platform: null })).toBe("editable");
  });
});

describe("what a screen shows", () => {
  it("stored values where there are some, defaults elsewhere, and what is customised", () => {
    const views = viewSettings({ stored: { "inventory.low_stock_threshold": 12 }, policies: {} });
    const low = views.find((v) => v.key === "inventory.low_stock_threshold");
    const days = views.find((v) => v.key === "inventory.expiry_warning_days");
    expect(low).toMatchObject({ value: 12, customised: true, state: "editable", group: "inventory", sensitive: false });
    expect(days).toMatchObject({ value: 30, customised: false });
    expect(views).toHaveLength(SETTING_KEYS.length);
  });

  it("a stored value that no longer fits is ignored in favour of the default", () => {
    const views = viewSettings({ stored: { "inventory.low_stock_threshold": "lots", "receipt.footer": 5 }, policies: {} });
    expect(views.find((v) => v.key === "inventory.low_stock_threshold")).toMatchObject({ value: 5, customised: false });
    expect(views.find((v) => v.key === "receipt.footer")).toMatchObject({ value: {}, customised: false });
  });

  it("hidden settings are left out, locked ones are shown as locked, sensitive ones say so", () => {
    const views = viewSettings({ stored: {}, policies: { "receipt.footer": { platform: "hidden" }, "inventory.low_stock_threshold": { tenant: "locked" } } });
    expect(views.find((v) => v.key === "receipt.footer")).toBeUndefined();
    expect(views.find((v) => v.key === "inventory.low_stock_threshold")?.state).toBe("locked");
    expect(views.find((v) => v.key === "business.phone")?.sensitive).toBe(true);
    expect(views.find((v) => v.key === "payments.telebirr_number")?.state).toBe("locked");
  });

  it("a stored value for a locked setting is still shown (it was set by the platform team)", () => {
    const views = viewSettings({ stored: { "pricing.max_discount_percent": 25 }, policies: {} });
    expect(views.find((v) => v.key === "pricing.max_discount_percent")).toMatchObject({ value: 25, state: "locked", customised: true });
  });

  it("reads one value, falling back to the default for a hidden or missing one", () => {
    const views = viewSettings({ stored: { "receipt.show_cashier": false }, policies: { "inventory.low_stock_threshold": { platform: "hidden" } } });
    expect(settingValue(views, "receipt.show_cashier")).toBe(false);
    expect(settingValue(views, "inventory.low_stock_threshold")).toBe(5);
    expect(settingValue([], "locale.default_language")).toBe("en");
  });

  it("does not trust inherited object keys as stored values", () => {
    const views = viewSettings({ stored: {}, policies: {} });
    expect(views.every((v) => !v.customised)).toBe(true);
  });
});
