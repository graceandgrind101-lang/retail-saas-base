import { describe, expect, it } from "vitest";
import { MODULE_KEYS } from "./modules";
import { ADMIN_NAV, POS_TABS, activeNavItem, buildAdminNav, flattenNav, phoneTabs, type NavItem } from "./navigation";
import { PERMISSION_KEYS, isPermissionKey } from "./permissions";

const ALL = new Set<string>(PERMISSION_KEYS);
const keys = (items: readonly NavItem[]) => items.map((i) => i.key);
const full = (over: Partial<Parameters<typeof buildAdminNav>[0]> = {}) => buildAdminNav({ enabledModules: MODULE_KEYS, permissions: ALL, includePlanned: true, ...over });

describe("the menu definition", () => {
  it("every item is well formed: unique key, a path, a real module and a real permission", () => {
    const seen = new Set<string>();
    for (const item of ADMIN_NAV) {
      expect(seen.has(item.key), `duplicate ${item.key}`).toBe(false);
      seen.add(item.key);
      expect(item.key).toMatch(/^[a-z0-9_]+$/);
      expect(item.path).toMatch(/^\/[a-z0-9/-]*$/);
      expect(item.module === "core" || (MODULE_KEYS as readonly string[]).includes(item.module), item.key).toBe(true);
      if (item.permission) expect(isPermissionKey(item.permission), `${item.key} permission`).toBe(true);
    }
    expect(new Set(ADMIN_NAV.map((i) => i.path)).size).toBe(ADMIN_NAV.length);
  });

  it("Home needs no permission (everyone signed in has somewhere to land)", () => {
    expect(ADMIN_NAV.find((i) => i.key === "home")?.permission).toBeUndefined();
  });

  it("only Home, Alerts and Settings exist so far", () => {
    expect(keys(ADMIN_NAV.filter((i) => i.built))).toEqual(["home", "alerts", "settings"]);
  });
});

describe("what a person sees", () => {
  it("planned screens stay out of the menu until they are built", () => {
    const nav = buildAdminNav({ enabledModules: MODULE_KEYS, permissions: ALL });
    expect(keys(flattenNav(nav))).toEqual(["home", "alerts", "settings"]);
    expect(nav.modules).toEqual([]);
    expect(keys(nav.configuration)).toEqual(["settings"]);
  });

  it("a module the shop has not switched on is hidden, with all its items", () => {
    const nav = full({ enabledModules: ["pos"] });
    expect(nav.modules.map((s) => s.module)).toEqual(["pos"]);
    expect(keys(flattenNav(nav))).not.toContain("products");
    expect(keys(flattenNav(full({ enabledModules: [] })).filter(() => true))).toEqual(["home", "alerts", "customers", "staff", "devices", "settings"]);
  });

  it("an item needs its permission, and a module with nothing left disappears", () => {
    const cashier = new Set(["sale:create", "sale:view", "alert:view"]);
    const nav = full({ permissions: cashier });
    expect(keys(flattenNav(nav))).toEqual(["home", "alerts", "sell", "sales"]);
    expect(nav.modules.map((s) => s.module)).toEqual(["pos"]);
    expect(keys(flattenNav(full({ permissions: new Set() })))).toEqual(["home"]);
  });

  it("configuration screens go in the CONFIGURATION group of their module, or the shop's own", () => {
    const nav = full();
    const inventory = nav.modules.find((s) => s.module === "inventory");
    expect(keys(inventory?.items ?? [])).toEqual(["products", "receive", "counts"]);
    expect(keys(inventory?.configuration ?? [])).toEqual(["suppliers"]);
    expect(keys(nav.configuration)).toEqual(["staff", "devices", "settings"]);
    expect(keys(nav.top)).toEqual(["home", "alerts", "customers"]);
  });

  it("modules appear in the menu's order, not the order the shop enabled them", () => {
    const nav = full({ enabledModules: ["reports", "inventory", "pos", "payments"] });
    expect(nav.modules.map((s) => s.module)).toEqual(["pos", "inventory", "payments", "reports"]);
  });

  it("does not change what it was given", () => {
    const enabled = ["pos"];
    const permissions = new Set(["sale:create"]);
    full({ enabledModules: enabled, permissions });
    expect(enabled).toEqual(["pos"]);
    expect([...permissions]).toEqual(["sale:create"]);
  });

  it("works on a custom list (for the menu's own tests)", () => {
    const items: NavItem[] = [{ key: "x", module: "reports", path: "/x", built: true }];
    expect(keys(flattenNav(buildAdminNav({ enabledModules: ["reports"], permissions: new Set(), items })))).toEqual(["x"]);
    expect(keys(flattenNav(buildAdminNav({ enabledModules: [], permissions: new Set(), items })))).toEqual([]);
  });
});

describe("the phone's bottom tabs", () => {
  it("Home, Sell, Stock and Alerts when all are reachable, with everything else under More", () => {
    const { tabs, more } = phoneTabs(full());
    expect(keys(tabs)).toEqual(["home", "sell", "products", "alerts"]);
    expect(keys(more)).toContain("settings");
    expect(keys(more)).not.toContain("home");
    expect(keys([...tabs, ...more]).sort()).toEqual(keys(flattenNav(full())).sort());
  });

  it("only offers tabs the person can reach", () => {
    const { tabs, more } = phoneTabs(full({ permissions: new Set(["alert:view"]) }));
    expect(keys(tabs)).toEqual(["home", "alerts"]);
    expect(more).toEqual([]);
  });

  it("today, with only the built screens, is Home and Alerts, with Settings under More", () => {
    const { tabs, more } = phoneTabs(buildAdminNav({ enabledModules: MODULE_KEYS, permissions: ALL }));
    expect(keys(tabs)).toEqual(["home", "alerts"]);
    expect(keys(more)).toEqual(["settings"]);
  });
});

describe("which item is current", () => {
  const items = ADMIN_NAV;
  it("matches the exact page, and a page inside it", () => {
    expect(activeNavItem(items, "/")?.key).toBe("home");
    expect(activeNavItem(items, "/alerts")?.key).toBe("alerts");
    expect(activeNavItem(items, "/products/5")?.key).toBe("products");
    expect(activeNavItem(items, "/products")?.key).toBe("products");
  });
  it("Home does not match everything, and a look-alike prefix does not match", () => {
    expect(activeNavItem(items, "/unknown")).toBeUndefined();
    expect(activeNavItem(items, "/productsx")).toBeUndefined();
    expect(activeNavItem(items, "/alertsfoo")).toBeUndefined();
  });
  it("the longest match wins", () => {
    const nested: NavItem[] = [
      { key: "a", module: "core", path: "/a", built: true },
      { key: "ab", module: "core", path: "/a/b", built: true },
    ];
    expect(activeNavItem(nested, "/a/b/c")?.key).toBe("ab");
    expect(activeNavItem(nested, "/a/c")?.key).toBe("a");
  });
});

describe("the POS tabs", () => {
  it("Sell, Today, Parked and More, in that order, under /pos", () => {
    expect(POS_TABS.map((t) => t.key)).toEqual(["sell", "today", "parked", "more"]);
    for (const tab of POS_TABS) expect(tab.path.startsWith("/pos")).toBe(true);
  });
});
