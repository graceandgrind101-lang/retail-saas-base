import type { ModuleKey } from "./modules";
import type { PermissionKey } from "./permissions";

/**
 * The admin app's menu (Phase A task A13, docs/SCREENS.md §1.2). One list says every screen the
 * pilot will have; what a person SEES is that list narrowed to the modules the shop has switched on
 * and the permissions the person holds. A module the shop has not enabled is hidden, not greyed out.
 *
 * `built` marks the screens that exist today. The rest are listed so the menu has room for them
 * and so adding one is a single line here, but they are not shown until they are built.
 *
 * The words come from the message files (`nav.<key>`), never from here.
 */
export interface NavItem {
  /** Also the message key: `nav.<key>`. Letters, digits and underscores. */
  key: string;
  /** The module it belongs to, or `core` (always on). */
  module: ModuleKey | "core";
  path: string;
  /** What a person needs to hold to see it. */
  permission?: PermissionKey;
  /** Inside the module's CONFIGURATION group instead of its main list. */
  configuration?: boolean;
  /** Does the screen exist yet? */
  built: boolean;
}

export const ADMIN_NAV: readonly NavItem[] = [
  { key: "home", module: "core", path: "/", built: true },
  { key: "alerts", module: "core", path: "/alerts", permission: "alert:view", built: true },

  { key: "sell", module: "pos", path: "/sell", permission: "sale:create", built: false },
  { key: "sales", module: "pos", path: "/sales", permission: "sale:view", built: false },
  { key: "shifts", module: "pos", path: "/shifts", permission: "shift:open", built: false },

  { key: "products", module: "inventory", path: "/products", permission: "product:view", built: false },
  { key: "receive", module: "inventory", path: "/receive", permission: "purchase:receive", built: false },
  { key: "counts", module: "inventory", path: "/counts", permission: "stock:count", built: false },
  { key: "suppliers", module: "inventory", path: "/suppliers", permission: "supplier:view", configuration: true, built: false },

  { key: "payments", module: "payments", path: "/payments", permission: "payment:view", built: false },

  { key: "customers", module: "core", path: "/customers", permission: "customer:view", built: false },
  { key: "reports", module: "reports", path: "/reports", permission: "report:view", built: false },

  { key: "staff", module: "core", path: "/staff", permission: "staff:view", configuration: true, built: false },
  { key: "devices", module: "core", path: "/devices", permission: "device:manage", configuration: true, built: false },
  { key: "settings", module: "core", path: "/settings", permission: "settings:view", configuration: true, built: false },
];

export interface NavSection {
  module: ModuleKey;
  items: NavItem[];
  configuration: NavItem[];
}

export interface AdminNav {
  /** Home, Alerts and other always-on screens that are not inside a module. */
  top: NavItem[];
  /** One section per enabled module that has something to show. */
  modules: NavSection[];
  /** The always-on screens that belong in a CONFIGURATION group (staff, devices, settings). */
  configuration: NavItem[];
}

export interface NavInput {
  enabledModules: readonly string[];
  permissions: ReadonlySet<string>;
  /** Show screens that are not built yet (for the menu's own tests and for planning). */
  includePlanned?: boolean;
  items?: readonly NavItem[];
}

/** The menu for one person in one shop. Order follows ADMIN_NAV; empty groups are left out. */
export function buildAdminNav({ enabledModules, permissions, includePlanned = false, items = ADMIN_NAV }: NavInput): AdminNav {
  const enabled = new Set(enabledModules);
  const visible = items.filter((item) => (item.built || includePlanned) && (item.module === "core" || enabled.has(item.module)) && (!item.permission || permissions.has(item.permission)));

  const modules: NavSection[] = [];
  for (const item of visible) {
    if (item.module === "core") continue;
    let section = modules.find((s) => s.module === item.module);
    if (!section) {
      section = { module: item.module, items: [], configuration: [] };
      modules.push(section);
    }
    (item.configuration ? section.configuration : section.items).push(item);
  }
  return {
    top: visible.filter((i) => i.module === "core" && !i.configuration),
    modules,
    configuration: visible.filter((i) => i.module === "core" && i.configuration),
  };
}

/** Every item the menu shows, flattened (for the Ctrl+K search and the phone's More list). */
export function flattenNav(nav: AdminNav): NavItem[] {
  return [...nav.top, ...nav.modules.flatMap((s) => [...s.items, ...s.configuration]), ...nav.configuration];
}

/**
 * The phone's bottom tabs: Home, Sell, Stock, Alerts, then More. A tab is only offered if the
 * person can reach it; More (everything else) is always last. At most four destinations + More.
 */
export const PHONE_TAB_PREFERENCE = ["home", "sell", "products", "alerts"] as const;

export function phoneTabs(nav: AdminNav): { tabs: NavItem[]; more: NavItem[] } {
  const all = flattenNav(nav);
  const tabs = PHONE_TAB_PREFERENCE.flatMap((key) => all.filter((item) => item.key === key));
  const used = new Set(tabs.map((t) => t.key));
  return { tabs, more: all.filter((item) => !used.has(item.key)) };
}

/** The item whose path is the longest prefix of the page being shown (so /products/5 highlights Products). */
export function activeNavItem(items: readonly NavItem[], pathname: string): NavItem | undefined {
  const matches = items.filter((item) => (item.path === "/" ? pathname === "/" : pathname === item.path || pathname.startsWith(`${item.path}/`)));
  return matches.sort((a, b) => b.path.length - a.path.length)[0];
}

/** The POS shell's tabs (docs/SCREENS.md §1.1). */
export const POS_TABS: readonly { key: string; path: string; built: boolean }[] = [
  { key: "sell", path: "/pos", built: false },
  { key: "today", path: "/pos/today", built: false },
  { key: "parked", path: "/pos/parked", built: false },
  { key: "more", path: "/pos/more", built: true },
];
