/**
 * Modules a shop can switch on (PLAN.md §2.5). The core is always on and is not listed here:
 * tenant and branches, staff and login, customers, catalog, the audit log, permissions,
 * settings, alerts and search.
 *
 * The list lives in code, not in a database enum, so adding a module is a code change with no
 * migration. The database only checks that a stored key is well formed
 * (platform.tenant_modules); this registry says which keys mean something.
 */
export const MODULE_KEYS = [
  "pos",
  "inventory",
  "payments",
  "dube",
  "promotions",
  "reports",
  "serials",
  "announcements",
  "storefront",
  "manufacturing",
  "transfers",
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

export function isModuleKey(value: string): value is ModuleKey {
  return (MODULE_KEYS as readonly string[]).includes(value);
}

export const INDUSTRIES = ["electronics", "minimarket", "cosmetics", "food", "other"] as const;
export type Industry = (typeof INDUSTRIES)[number];

/**
 * Modules switched on for a new shop. This is the MVP set (PLAN.md D11, pilot cut): what a
 * pilot shop needs on day one. Dube, storefront, manufacturing and transfers are later modules
 * and are enabled per shop by the platform team when they exist.
 * Electronics shops also get serials (IMEI and warranty).
 */
export function defaultModulesFor(industry: Industry): ModuleKey[] {
  const base: ModuleKey[] = ["pos", "inventory", "payments", "promotions", "reports", "announcements"];
  return industry === "electronics" ? [...base, "serials"] : base;
}
