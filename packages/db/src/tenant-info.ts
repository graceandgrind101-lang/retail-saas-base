import { sql } from "drizzle-orm";
import { isModuleKey, type Industry, type LocalizedText, type ModuleKey } from "@retail/core";
import type { RlsTransaction } from "./rls";

/**
 * What a shop's own session may know about itself. `platform` is closed to shops; these read
 * through two small SECURITY DEFINER functions (migration 0004) that return only the row of the
 * tenant named by the request context.
 */

export type TenantStatus = "pilot" | "trial" | "active" | "past_due" | "paused" | "closed";

export interface MyTenant {
  id: string;
  slug: string;
  displayName: LocalizedText;
  status: TenantStatus;
  industry: Industry;
  planKey: string;
  timezone: string;
  currency: string;
}

export async function getMyTenant(tx: RlsTransaction): Promise<MyTenant | null> {
  const rows = await tx.execute<{
    id: string;
    slug: string;
    display_name: LocalizedText;
    status: TenantStatus;
    industry: Industry;
    plan_key: string;
    timezone: string;
    currency: string;
  }>(sql`select id, slug, display_name, status, industry, plan_key, timezone, currency from app.my_tenant()`);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    status: row.status,
    industry: row.industry,
    planKey: row.plan_key,
    timezone: row.timezone,
    currency: row.currency,
  };
}

/** The modules switched on for this shop. Stored keys the code does not know are ignored. */
export async function getEnabledModules(tx: RlsTransaction): Promise<ModuleKey[]> {
  const rows = await tx.execute<{ module_key: string }>(sql`select app.my_modules() as module_key`);
  return rows.map((r) => r.module_key).filter(isModuleKey);
}

/** Paused and closed shops can read everything and change nothing (PLAN.md §7.16). */
export function isReadOnlyStatus(status: TenantStatus): boolean {
  return status === "paused" || status === "closed";
}

/**
 * True when a database error means "this shop is paused or closed" (SQLSTATE 25006, raised by
 * the enforce_writable trigger), so the app can show "your account is paused" instead of a
 * generic failure.
 */
export function isShopReadOnlyError(error: unknown): boolean {
  const e = error as { code?: unknown; cause?: unknown } | null;
  if (e && e.code === "25006") return true;
  return e?.cause ? isShopReadOnlyError(e.cause) : false;
}
