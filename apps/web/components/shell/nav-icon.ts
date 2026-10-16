import type { IconName } from "@retail/ui";

/** Which icon goes with each menu item (every item also has its word). */
const ICONS: Record<string, IconName> = {
  home: "home",
  alerts: "bell",
  sell: "cart",
  sales: "receipt",
  shifts: "cash",
  products: "box",
  receive: "box",
  counts: "check",
  suppliers: "users",
  payments: "phone",
  customers: "users",
  reports: "chart",
  staff: "users",
  devices: "phone",
  settings: "gear",
};

export const navIcon = (key: string): IconName => ICONS[key] ?? "menu";
