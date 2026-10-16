import { sql } from "drizzle-orm";
import {
  SESSION_HOURS,
  hashInviteToken,
  isWellFormedInviteToken,
  uuidv7,
  type LocalizedText,
  type SessionEndReason,
} from "@retail/core";
import { InviteInvalidError, translateAuthError } from "./errors";
import type { IdentityTransaction, RlsTransaction } from "./rls";
import type { TenantStatus } from "./tenant-info";

/**
 * Getting from "a verified login account" to "this staff member in this shop" (task A7).
 * Everything here runs inside `db.identity()` (account, no shop yet) or `db.rls()` (in a shop).
 * The checks live in the database (migration 0006); these are thin, typed doors to it.
 */

export interface MyShop {
  tenantId: string;
  slug: string;
  displayName: LocalizedText;
  tenantStatus: TenantStatus;
  staffId: string;
  staffName: string;
  roleKey: string;
}

/** The shop picker: every shop where this account is an active staff member. */
export async function listMyShops(tx: IdentityTransaction): Promise<MyShop[]> {
  const rows = await tx.execute<{
    tenant_id: string;
    slug: string;
    display_name: LocalizedText;
    tenant_status: TenantStatus;
    staff_id: string;
    staff_name: string;
    role_key: string;
  }>(sql`select tenant_id, slug, display_name, tenant_status, staff_id, staff_name, role_key from app.my_shops()`);
  return rows.map((r) => ({
    tenantId: r.tenant_id,
    slug: r.slug,
    displayName: r.display_name,
    tenantStatus: r.tenant_status,
    staffId: r.staff_id,
    staffName: r.staff_name,
    roleKey: r.role_key,
  }));
}

/**
 * Follow an invitation link. Throws `InviteInvalidError` for EVERY way it can be wrong (unknown,
 * used, expired, a different email than the invited one, paused or closed shop): one answer, so
 * it cannot be used to find out which tokens exist.
 */
export async function acceptInvite(tx: IdentityTransaction, token: string): Promise<{ tenantId: string; staffId: string }> {
  if (!isWellFormedInviteToken(token)) throw new InviteInvalidError(); // junk never reaches the database
  const tokenHash = await hashInviteToken(token);
  const rows = await tx.execute<{ tenant_id: string; staff_id: string }>(
    sql`select tenant_id, staff_id from app.accept_invite(${tokenHash})`,
  );
  const row = rows[0];
  if (!row) throw new InviteInvalidError();
  return { tenantId: row.tenant_id, staffId: row.staff_id };
}

export interface StartedSession {
  /** Goes into the signed cookie. */
  sessionId: string;
  staffId: string;
  tenantId: string;
  expiresAt: Date;
}

/**
 * Sign the verified account in to one shop. The person is found by the verified account, never
 * by anything the browser claims. Throws `NoShopAccessError` if the account is not an active
 * member of that shop. A paused shop may be entered (it is read-only); a closed one may not.
 */
export async function startSession(
  tx: IdentityTransaction,
  input: { tenantId: string; method: "password" | "google"; hours?: number },
): Promise<StartedSession> {
  const sessionId = uuidv7();
  const expiresAt = new Date(Date.now() + (input.hours ?? SESSION_HOURS.admin) * 3_600_000);
  const rows = await tx.execute<{ staff_id: string }>(
    sql`select staff_id from app.start_session(${sessionId}::uuid, ${input.tenantId}::uuid, ${input.method}, ${expiresAt.toISOString()}::timestamptz)`,
  );
  const row = rows[0];
  if (!row) throw new Error("app.start_session returned nothing");
  return { sessionId, staffId: row.staff_id, tenantId: input.tenantId, expiresAt };
}

/**
 * Sign out: ends THIS request's session. Works for a paused shop too. Returns false if it was
 * already over. Other sessions of the same person are untouched.
 */
export async function endMySession(tx: RlsTransaction, reason: Extract<SessionEndReason, "logout" | "revoked"> = "logout"): Promise<boolean> {
  try {
    const rows = await tx.execute<{ ended: boolean }>(sql`select app.end_my_session(${reason}) as ended`);
    return rows[0]?.ended === true;
  } catch (error) {
    throw translateAuthError(error);
  }
}

export interface MyStaff {
  staffId: string;
  name: string;
  roleKey: string;
  /** Null follows the shop's default (English unless the shop changed it). */
  language: string | null;
  calendar: "gregorian" | "ethiopian" | null;
  theme: "system" | "light" | "dark" | null;
}

/** Who the signed-in person is in this shop (name, role, their own display preferences). */
export async function getMyStaff(tx: RlsTransaction): Promise<MyStaff | null> {
  const rows = await tx.execute<{
    id: string;
    display_name: string;
    role_key: string;
    preferred_language: string | null;
    preferred_calendar: MyStaff["calendar"];
    theme: MyStaff["theme"];
  }>(sql`
    select s.id, s.display_name, r.key as role_key, s.preferred_language, s.preferred_calendar, s.theme
    from app.staff s
    join app.roles r on r.tenant_id = s.tenant_id and r.id = s.role_id
    where s.id = private.ctx_staff()`);
  const row = rows[0];
  if (!row) return null;
  return {
    staffId: row.id,
    name: row.display_name,
    roleKey: row.role_key,
    language: row.preferred_language,
    calendar: row.preferred_calendar,
    theme: row.theme,
  };
}
