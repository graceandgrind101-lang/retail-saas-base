import { describe, expect, it } from "vitest";
import { MODULE_KEYS } from "./modules";
import {
  PERMISSIONS,
  PERMISSION_KEYS,
  PERMISSION_KEY_FORMAT,
  ROLE_TEMPLATE_PERMISSIONS,
  isPermissionKey,
  keysNotHeld,
  needsApproval,
  permissionModule,
  permissionsOfModules,
  registryProblems,
  resolvePermissions,
} from "./permissions";

const ALL_MODULES = [...MODULE_KEYS];
const resolve = (over: Partial<Parameters<typeof resolvePermissions>[0]> = {}) =>
  resolvePermissions({ roleKey: "cashier", rolePermissions: [], overrides: [], enabledModules: ALL_MODULES, ...over });

describe("the registry", () => {
  it("has no problems (unique, well-formed keys, real modules, templates that name real keys)", () => {
    expect(registryProblems()).toEqual([]);
  });

  it("every key fits the database's format", () => {
    for (const key of PERMISSION_KEYS) expect(key).toMatch(PERMISSION_KEY_FORMAT);
  });

  it("every module has at least one key, and the keys of the plan's examples exist", () => {
    for (const module of MODULE_KEYS) expect(PERMISSIONS.some((p) => p.module === module), module).toBe(true);
    for (const key of ["product:edit_price", "discount:create", "sale:below_floor", "payment:verify", "dube:write_off"]) {
      expect(isPermissionKey(key), key).toBe(true);
    }
  });

  it("knows which module a key belongs to, and nothing about unknown keys", () => {
    expect(permissionModule("staff:manage")).toBe("core");
    expect(permissionModule("sale:void")).toBe("pos");
    expect(permissionModule("dube:write_off")).toBe("dube");
    expect(permissionModule("nope:nope")).toBeNull();
    expect(isPermissionKey("nope:nope")).toBe(false);
    expect(isPermissionKey("")).toBe(false);
  });

  it("marks exactly the actions the plan sends to a second person's PIN", () => {
    const approval = PERMISSION_KEYS.filter((k) => needsApproval(k)).sort();
    expect(approval).toEqual(["discount:create", "dube:write_off", "product:edit_price", "refund:create", "sale:below_floor", "sale:void"]);
    expect(needsApproval("nope:nope")).toBe(false);
  });

  it("the core is always on; a module's keys appear only when it is enabled", () => {
    const none = permissionsOfModules([]);
    expect(none).toContain("staff:manage");
    expect(none).not.toContain("sale:create");
    expect(permissionsOfModules(["pos"])).toContain("sale:create");
    expect(permissionsOfModules(["pos"])).not.toContain("stock:view");
    expect(permissionsOfModules(ALL_MODULES)).toHaveLength(PERMISSIONS.length);
  });
});

describe("the system role templates", () => {
  it("the manager can run the shop and its people but not change roles or sensitive settings", () => {
    const manager = new Set<string>(ROLE_TEMPLATE_PERMISSIONS.manager);
    expect(manager.has("role:manage")).toBe(false);
    expect(manager.has("settings:edit")).toBe(false);
    expect(manager.has("staff:manage")).toBe(true);
    expect(manager.has("device:manage")).toBe(true);
    expect(manager.has("sale:below_floor")).toBe(true);
  });

  it("a cashier can sell but not approve, manage, or see reports", () => {
    const cashier = new Set<string>(ROLE_TEMPLATE_PERMISSIONS.cashier);
    expect(cashier.has("sale:create")).toBe(true);
    for (const key of ["sale:void", "sale:below_floor", "discount:create", "refund:create", "product:edit_price", "staff:manage", "device:manage", "report:view", "stock:adjust"]) {
      expect(cashier.has(key), key).toBe(false);
    }
  });

  it("a viewer can look but never change", () => {
    for (const key of ROLE_TEMPLATE_PERMISSIONS.viewer) expect(key.endsWith(":view"), key).toBe(true);
    expect(ROLE_TEMPLATE_PERMISSIONS.viewer).toContain("report:view");
    expect(ROLE_TEMPLATE_PERMISSIONS.viewer).not.toContain("report:export");
  });

  it("no template other than the manager's holds a power over people, roles or devices", () => {
    for (const role of ["cashier", "stock_clerk", "viewer"] as const) {
      for (const key of ["staff:manage", "role:manage", "device:manage", "settings:edit"]) {
        expect(ROLE_TEMPLATE_PERMISSIONS[role] as readonly string[], `${role} ${key}`).not.toContain(key);
      }
    }
  });
});

describe("resolvePermissions", () => {
  it("a role gives exactly its keys", () => {
    const keys = resolve({ rolePermissions: ["sale:create", "product:view"] });
    expect([...keys].sort()).toEqual(["product:view", "sale:create"]);
  });

  it("the owner holds every key of every enabled module, whatever is stored for the role", () => {
    expect(resolve({ roleKey: "owner", rolePermissions: [] }).size).toBe(PERMISSIONS.length);
    expect([...resolve({ roleKey: "owner", enabledModules: [] })].sort()).toEqual(permissionsOfModules([]).sort());
  });

  it("a new module's keys reach the owner at once", () => {
    expect(resolve({ roleKey: "owner", enabledModules: ["pos"] }).has("stock:view")).toBe(false);
    expect(resolve({ roleKey: "owner", enabledModules: ["pos", "inventory"] }).has("stock:view")).toBe(true);
  });

  it("an allow adds a key the role lacks", () => {
    const keys = resolve({ rolePermissions: ["sale:create"], overrides: [{ key: "sale:void", effect: "allow" }] });
    expect(keys.has("sale:void")).toBe(true);
    expect(keys.has("sale:create")).toBe(true);
  });

  it("a deny really removes a key: from the role, from an allow, and from the owner", () => {
    expect(resolve({ rolePermissions: ["sale:create"], overrides: [{ key: "sale:create", effect: "deny" }] }).has("sale:create")).toBe(false);
    const both = [
      { key: "sale:void", effect: "allow" },
      { key: "sale:void", effect: "deny" },
    ] as const;
    expect(resolve({ overrides: both }).has("sale:void")).toBe(false);
    expect(resolve({ overrides: [...both].reverse() }).has("sale:void")).toBe(false);
    expect(resolve({ roleKey: "owner", overrides: [{ key: "refund:create", effect: "deny" }] }).has("refund:create")).toBe(false);
    expect(resolve({ roleKey: "owner", overrides: [{ key: "refund:create", effect: "deny" }] }).has("sale:void")).toBe(true);
  });

  it("keys of a switched-off module are never held, even by role, allow or owner", () => {
    const off = ["inventory", "payments", "dube", "promotions", "reports", "serials", "announcements", "storefront", "manufacturing", "transfers"];
    expect(resolve({ enabledModules: off, rolePermissions: ["sale:create", "stock:view"] }).has("sale:create")).toBe(false);
    expect(resolve({ enabledModules: off, rolePermissions: ["stock:view"] }).has("stock:view")).toBe(true);
    expect(resolve({ enabledModules: off, overrides: [{ key: "sale:create", effect: "allow" }] }).has("sale:create")).toBe(false);
    expect(resolve({ roleKey: "owner", enabledModules: off }).has("sale:create")).toBe(false);
  });

  it("unknown keys are dropped, and only the exact role key 'owner' is the owner", () => {
    expect(resolve({ rolePermissions: ["nope:nope", "sale:create"] }).has("sale:create")).toBe(true);
    expect(resolve({ rolePermissions: ["nope:nope"] }).size).toBe(0);
    expect(resolve({ roleKey: "Owner" }).size).toBe(0);
    expect(resolve({ roleKey: "owner_custom" }).size).toBe(0);
    expect(resolve({ overrides: [{ key: "nope:nope", effect: "allow" }] }).size).toBe(0);
  });

  it("does not change its inputs", () => {
    const role = ["sale:create"];
    const overrides = [{ key: "sale:void", effect: "allow" as const }];
    resolve({ rolePermissions: role, overrides });
    expect(role).toEqual(["sale:create"]);
    expect(overrides).toHaveLength(1);
  });

  it("the shipped templates resolve to sensible sets", () => {
    const cashier = resolve({ rolePermissions: ROLE_TEMPLATE_PERMISSIONS.cashier });
    expect(cashier.has("sale:create")).toBe(true);
    expect(cashier.has("sale:void")).toBe(false);
    const posOnly = resolve({ rolePermissions: ROLE_TEMPLATE_PERMISSIONS.manager, enabledModules: ["pos"] });
    expect(posOnly.has("sale:void")).toBe(true);
    expect(posOnly.has("stock:adjust")).toBe(false);
  });
});

describe("keysNotHeld (only grant what you hold)", () => {
  it("returns the keys the granter lacks, in order, and nothing when all are held", () => {
    const held = new Set(["sale:create", "product:view"]);
    expect(keysNotHeld(held, ["sale:create"])).toEqual([]);
    expect(keysNotHeld(held, ["sale:create", "sale:void", "refund:create"])).toEqual(["sale:void", "refund:create"]);
    expect(keysNotHeld(held, [])).toEqual([]);
    expect(keysNotHeld(new Set(), ["sale:create"])).toEqual(["sale:create"]);
  });
});
