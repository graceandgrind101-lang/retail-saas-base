import { z } from "zod";

/**
 * Settings (Phase A task A14, PLAN.md §4): the choices a shop can make about itself. The REGISTRY
 * below is the one list of them: each setting's name, the kind of value it holds, its default, the
 * section it belongs to, whether saving it asks for the person's PIN, and its launch state (what the
 * shop may do with it before the platform team changes that for one shop or for everyone).
 *
 *  - `editable`: the shop's owner may change it.
 *  - `locked`: shown with a lock; only the platform team changes it (PLAN §4: payment accounts,
 *    pricing rules, security ...). A locked setting cannot be saved by the shop, however the request is made.
 *  - `hidden`: not shown and not changeable.
 *
 * Stored values are validated here on the way in, and the labels come from the message files
 * (`settings.<group>.<name>.label`), never from this file.
 */
export const SETTING_GROUPS = ["business", "receipt", "inventory", "locale", "payments", "pricing", "security"] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

export const SETTING_STATES = ["editable", "locked", "hidden"] as const;
export type SettingState = (typeof SETTING_STATES)[number];

/** Text in the shop's own languages, e.g. `{ en: "Open 8 to 6", am: "..." }`. */
export type LocalizedValue = Partial<Record<string, string>>;

interface Base {
  group: SettingGroup;
  /** Saving it asks the person to type their own PIN first. */
  sensitive?: true;
  /** What the shop may do with it at launch. */
  state: SettingState;
}
export type SettingDef = Base &
  (
    | { kind: "text"; default: string; max: number }
    | { kind: "localized"; default: LocalizedValue; max: number }
    | { kind: "boolean"; default: boolean }
    | { kind: "integer"; default: number; min: number; max: number }
    | { kind: "enum"; default: string; options: readonly string[] }
    /** A language code; the app also checks it is a language it offers. */
    | { kind: "language"; default: string }
  );

export const SETTINGS = {
  "business.phone": { group: "business", kind: "text", default: "", max: 32, sensitive: true, state: "editable" },
  "business.address": { group: "business", kind: "localized", default: {}, max: 200, state: "editable" },
  "business.opening_hours": { group: "business", kind: "localized", default: {}, max: 200, state: "editable" },

  "receipt.footer": { group: "receipt", kind: "localized", default: {}, max: 200, state: "editable" },
  "receipt.show_cashier": { group: "receipt", kind: "boolean", default: true, state: "editable" },
  "receipt.not_fiscal_label": { group: "receipt", kind: "boolean", default: true, state: "locked" },

  "inventory.low_stock_threshold": { group: "inventory", kind: "integer", default: 5, min: 0, max: 10_000, state: "editable" },
  "inventory.expiry_warning_days": { group: "inventory", kind: "integer", default: 30, min: 1, max: 365, state: "editable" },

  "locale.default_language": { group: "locale", kind: "language", default: "en", state: "editable" },
  "locale.default_calendar": { group: "locale", kind: "enum", default: "gregorian", options: ["gregorian", "ethiopian"], state: "editable" },

  // Payment accounts are locked for good: a swapped payee number is the classic theft (PLAN §4).
  "payments.telebirr_number": { group: "payments", kind: "text", default: "", max: 32, sensitive: true, state: "locked" },
  "payments.cbe_account": { group: "payments", kind: "text", default: "", max: 32, sensitive: true, state: "locked" },

  "pricing.max_discount_percent": { group: "pricing", kind: "integer", default: 10, min: 0, max: 100, state: "locked" },

  "security.pos_idle_lock_seconds": { group: "security", kind: "integer", default: 180, min: 0, max: 86_400, state: "locked" },
} as const satisfies Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTINGS;
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

/** The shape the database accepts for any stored key (`group.name`). */
export const SETTING_KEY_FORMAT = /^[a-z][a-z_]*\.[a-z][a-z_]*$/;

export function isSettingKey(value: string): value is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS, value);
}

export const settingGroupOf = (key: SettingKey): SettingGroup => SETTINGS[key].group;
export const settingName = (key: SettingKey): string => key.slice(key.indexOf(".") + 1);

/** The message path of a setting's label: `settings.receipt.footer.label`. */
export const settingLabelPath = (key: SettingKey): string => `settings.${key}.label`;
export const settingHelpPath = (key: SettingKey): string => `settings.${key}.help`;

const LANGUAGE_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** The rule a value must satisfy, built from the registry entry. */
export function settingSchema(key: SettingKey): z.ZodType<unknown> {
  const def: SettingDef = SETTINGS[key];
  switch (def.kind) {
    case "text":
      return z.string().max(def.max).refine((v) => v === v.trim(), "no spaces at the ends");
    case "localized":
      return z
        .record(z.string().regex(LANGUAGE_CODE), z.string().max(def.max).refine((v) => v === v.trim(), "no spaces at the ends"))
        .refine((v) => Object.keys(v).length <= 20, "too many languages");
    case "boolean":
      return z.boolean();
    case "integer":
      return z.number().int().min(def.min).max(def.max);
    case "enum":
      return z.enum(def.options as [string, ...string[]]);
    case "language":
      return z.string().regex(LANGUAGE_CODE);
  }
}

export type ParsedSetting = { ok: true; value: unknown } | { ok: false };

/** Check a value for a setting. Empty texts inside a localized value are dropped (an empty language means "not written"). */
export function parseSettingValue(key: SettingKey, raw: unknown): ParsedSetting {
  const def: SettingDef = SETTINGS[key];
  let candidate = raw;
  if (def.kind === "localized" && typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    candidate = Object.fromEntries(Object.entries(raw).filter(([, text]) => !(typeof text === "string" && text === "")));
  }
  const result = settingSchema(key).safeParse(candidate);
  return result.success ? { ok: true, value: result.data } : { ok: false };
}

/** Does a stored value (or the default) fit its setting? Used to ignore a stored value that no longer fits. */
export function isValidSettingValue(key: SettingKey, value: unknown): boolean {
  return parseSettingValue(key, value).ok;
}

/**
 * What a setting may be done with right now: the shop's own policy row beats the platform-wide
 * one, which beats the launch state in the registry above.
 */
export function effectiveSettingState(key: SettingKey, policy: { tenant?: SettingState | null; platform?: SettingState | null }): SettingState {
  return policy.tenant ?? policy.platform ?? SETTINGS[key].state;
}

export interface SettingView {
  key: SettingKey;
  group: SettingGroup;
  value: unknown;
  /** Is the value one the shop saved (true) or the default (false)? */
  customised: boolean;
  state: SettingState;
  sensitive: boolean;
}

/** Turn what is stored and the policies into what a screen shows. Hidden settings are left out. */
export function viewSettings(input: {
  stored: Readonly<Record<string, unknown>>;
  policies: Readonly<Record<string, { tenant?: SettingState | null; platform?: SettingState | null }>>;
}): SettingView[] {
  const views: SettingView[] = [];
  for (const key of SETTING_KEYS) {
    const state = effectiveSettingState(key, input.policies[key] ?? {});
    if (state === "hidden") continue;
    const has = Object.prototype.hasOwnProperty.call(input.stored, key) && isValidSettingValue(key, input.stored[key]);
    const def: SettingDef = SETTINGS[key];
    views.push({
      key,
      group: def.group,
      value: has ? input.stored[key] : def.default,
      customised: has,
      state,
      sensitive: def.sensitive === true,
    });
  }
  return views;
}

/** The value of one setting from a loaded list (the default if the setting is hidden or unknown). */
export function settingValue<K extends SettingKey>(views: readonly SettingView[], key: K): unknown {
  return views.find((v) => v.key === key)?.value ?? SETTINGS[key].default;
}

/** Problems with the registry itself; a test calls this so a bad edit fails CI. */
export function settingsProblems(): string[] {
  const problems: string[] = [];
  const groups = new Set<string>(SETTING_GROUPS);
  for (const key of SETTING_KEYS) {
    const def: SettingDef = SETTINGS[key];
    if (!SETTING_KEY_FORMAT.test(key)) problems.push(`${key}: bad key format`);
    if (!groups.has(def.group)) problems.push(`${key}: unknown group ${def.group}`);
    if (key.split(".")[0] !== def.group) problems.push(`${key}: the key must start with its group`);
    if (!(SETTING_STATES as readonly string[]).includes(def.state)) problems.push(`${key}: bad state`);
    if (!parseSettingValue(key, def.default).ok) problems.push(`${key}: the default does not satisfy its own rule`);
  }
  return problems;
}
