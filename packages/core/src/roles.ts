import type { LocalizedText } from "./types";

/**
 * The roles every shop starts with (PLAN.md §5, DATA_MODEL `app.roles`). Created with the shop
 * by `provisionTenant`. What each role may DO is the permission list, added in task A9; the
 * Owner role will hold every permission of every enabled module.
 *
 * The names are stored as data in each shop (so an owner can rename them), which is why they
 * are written here in both languages instead of in the interface message files.
 */
export const SYSTEM_ROLE_KEYS = ["owner", "manager", "cashier", "stock_clerk", "viewer"] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

export const SYSTEM_ROLES: Record<SystemRoleKey, { name: LocalizedText }> = {
  owner: { name: { en: "Owner", am: "ባለቤት" } },
  manager: { name: { en: "Manager", am: "ሥራ አስኪያጅ" } },
  cashier: { name: { en: "Cashier", am: "ገንዘብ ተቀባይ" } },
  stock_clerk: { name: { en: "Stock clerk", am: "የመጋዘን ሠራተኛ" } },
  viewer: { name: { en: "Viewer", am: "ተመልካች" } },
};

export function isSystemRoleKey(value: string): value is SystemRoleKey {
  return (SYSTEM_ROLE_KEYS as readonly string[]).includes(value);
}

/** How long a sign-in lasts before the person must sign in again (hours). */
export const SESSION_HOURS = {
  /** Owners and managers using the admin app on their own phone or computer. */
  admin: 24 * 7,
  /** A cashier on the shop's till (docs/SCREENS.md; the same as the reference app). */
  pos: 12,
} as const;

export type SessionMethod = "pin" | "password" | "google" | "telegram";
export type SessionEndReason = "logout" | "expired" | "revoked" | "staff_suspended" | "device_revoked";
