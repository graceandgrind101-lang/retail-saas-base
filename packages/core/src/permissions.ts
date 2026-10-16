import { MODULE_KEYS, type ModuleKey } from "./modules";
import type { SystemRoleKey } from "./roles";

/**
 * Permissions (Phase A task A9, PLAN.md §5). A permission is a `resource:action` key. The list
 * lives here, in code, so adding one is a code change with no migration; the database only checks
 * that a stored key is well formed.
 *
 * Each key belongs to the core (always on) or to one module. A key of a module the shop has not
 * switched on is never held by anyone, whatever the roles say.
 *
 * `approval: true` marks the actions a till asks a second person to approve with their own PIN
 * (PLAN §5 "step-up": price change, discount, below-floor sale, void, refund, Dube write-off).
 */
export interface PermissionDef {
  key: string;
  module: ModuleKey | "core";
  approval?: true;
}

const def = (module: PermissionDef["module"], key: string, approval?: true): PermissionDef => ({ key, module, ...(approval ? { approval } : {}) });

export const PERMISSIONS = [
  // core: always on
  def("core", "staff:view"),
  def("core", "staff:manage"),
  def("core", "role:manage"),
  def("core", "device:manage"),
  def("core", "settings:view"),
  def("core", "settings:edit"),
  def("core", "audit:view"),
  def("core", "customer:view"),
  def("core", "customer:edit"),
  def("core", "product:view"),
  def("core", "product:create"),
  def("core", "product:edit"),
  def("core", "product:edit_price", true),
  def("core", "product:archive"),
  def("core", "alert:view"),
  def("core", "alert:resolve"),
  // modules
  def("pos", "sale:create"),
  def("pos", "sale:view"),
  def("pos", "sale:void", true),
  def("pos", "sale:below_floor", true),
  def("pos", "discount:create", true),
  def("pos", "refund:create", true),
  def("pos", "shift:open"),
  def("pos", "shift:close"),
  def("pos", "cash:adjust"),
  def("inventory", "stock:view"),
  def("inventory", "stock:adjust"),
  def("inventory", "stock:count"),
  def("inventory", "purchase:create"),
  def("inventory", "purchase:receive"),
  def("inventory", "supplier:view"),
  def("inventory", "supplier:edit"),
  def("payments", "payment:view"),
  def("payments", "payment:verify"),
  def("dube", "dube:view"),
  def("dube", "dube:write"),
  def("dube", "dube:write_off", true),
  def("promotions", "promotion:view"),
  def("promotions", "promotion:manage"),
  def("reports", "report:view"),
  def("reports", "report:export"),
  def("serials", "serial:view"),
  def("serials", "serial:edit"),
  def("announcements", "announcement:view"),
  def("announcements", "announcement:manage"),
  def("storefront", "storefront:manage"),
  def("manufacturing", "production:view"),
  def("manufacturing", "production:manage"),
  def("transfers", "transfer:create"),
  def("transfers", "transfer:receive"),
] as const satisfies readonly PermissionDef[];

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];

const BY_KEY: ReadonlyMap<string, PermissionDef> = new Map(PERMISSIONS.map((p) => [p.key, p]));

export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSIONS.map((p) => p.key);

/** The shape the database accepts for any stored key (a CHECK on the permission tables). */
export const PERMISSION_KEY_FORMAT = /^[a-z][a-z_]*:[a-z][a-z_]*$/;

export function isPermissionKey(value: string): value is PermissionKey {
  return BY_KEY.has(value);
}

/** `core` or the module a key belongs to; null for a key we do not know. */
export function permissionModule(key: string): PermissionDef["module"] | null {
  return BY_KEY.get(key)?.module ?? null;
}

/** Does using this key call for a second person's PIN? */
export function needsApproval(key: string): boolean {
  return BY_KEY.get(key)?.approval === true;
}

/** Every key that exists in a shop with these modules switched on (the core is always on). */
export function permissionsOfModules(enabled: readonly string[]): PermissionKey[] {
  const on = new Set<string>(enabled);
  return PERMISSIONS.filter((p) => p.module === "core" || on.has(p.module)).map((p) => p.key);
}

const view = (key: string) => key.endsWith(":view");

const OPERATIONAL = PERMISSIONS.filter((p) => p.module !== "core" || !["role:manage", "settings:edit"].includes(p.key)).map((p) => p.key);

/**
 * What each system role gets, as keys of ANY module (the resolver drops what the shop has not
 * switched on). The Owner has no list: it holds every key of every enabled module, including
 * keys added later. While "Staff & roles" is locked (D7) only the platform console changes these.
 */
export const ROLE_TEMPLATE_PERMISSIONS: Record<Exclude<SystemRoleKey, "owner">, readonly PermissionKey[]> = {
  // Everything day to day. Not: changing roles, or sensitive settings (those stay with the owner).
  manager: OPERATIONAL,
  cashier: [
    "product:view",
    "customer:view",
    "customer:edit",
    "sale:create",
    "sale:view",
    "shift:open",
    "shift:close",
    "payment:view",
    "stock:view",
    "serial:view",
    "promotion:view",
    "announcement:view",
  ],
  stock_clerk: [
    "product:view",
    "product:create",
    "product:edit",
    "stock:view",
    "stock:adjust",
    "stock:count",
    "purchase:create",
    "purchase:receive",
    "supplier:view",
    "supplier:edit",
    "serial:view",
    "serial:edit",
    "transfer:create",
    "transfer:receive",
  ],
  viewer: PERMISSIONS.filter((p) => view(p.key) || p.key === "report:view").map((p) => p.key),
};

export type OverrideEffect = "allow" | "deny";

export interface PermissionOverride {
  key: string;
  effect: OverrideEffect;
}

export interface ResolveInput {
  /** The person's role key. `owner` holds every key of every enabled module. */
  roleKey: string;
  /** The keys stored for the role (ignored for the owner). */
  rolePermissions: readonly string[];
  /** Personal exceptions for this person. */
  overrides: readonly PermissionOverride[];
  /** The shop's switched-on modules. */
  enabledModules: readonly string[];
}

/**
 * THE resolver: what a person may do right now. (role, or all of them for the Owner) plus personal
 * `allow`s, minus personal `deny`s, limited to keys that exist in the shop's enabled modules.
 *  - A deny always wins, over the role, an allow and the Owner.
 *  - Unknown keys and keys of switched-off modules are dropped.
 * Only the caller decides WHO to resolve for; it must load the inputs fresh on every privileged action.
 */
export function resolvePermissions(input: ResolveInput): Set<PermissionKey> {
  const available = new Set<string>(permissionsOfModules(input.enabledModules));
  const held = new Set<string>(input.roleKey === "owner" ? available : input.rolePermissions);
  for (const o of input.overrides) {
    if (o.effect === "allow") held.add(o.key);
  }
  for (const o of input.overrides) {
    if (o.effect === "deny") held.delete(o.key);
  }
  return new Set([...held].filter((key): key is PermissionKey => isPermissionKey(key) && available.has(key)));
}

/**
 * "You can only grant keys you hold": which of the requested keys the granter does NOT hold.
 * An empty list means the grant is allowed.
 */
export function keysNotHeld(granterHolds: ReadonlySet<string>, requested: readonly string[]): string[] {
  return requested.filter((key) => !granterHolds.has(key));
}

/** Sanity checks on the registry itself; called by a test so a bad edit fails CI. */
export function registryProblems(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const p of PERMISSIONS) {
    if (seen.has(p.key)) problems.push(`duplicate key ${p.key}`);
    seen.add(p.key);
    if (!PERMISSION_KEY_FORMAT.test(p.key)) problems.push(`bad format ${p.key}`);
    if (p.module !== "core" && !(MODULE_KEYS as readonly string[]).includes(p.module)) problems.push(`unknown module ${p.module} for ${p.key}`);
  }
  for (const [role, keys] of Object.entries(ROLE_TEMPLATE_PERMISSIONS)) {
    for (const key of keys) if (!seen.has(key)) problems.push(`${role} template names unknown key ${key}`);
  }
  return problems;
}
