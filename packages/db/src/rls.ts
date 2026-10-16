import { sql } from "drizzle-orm";
import { isUuid } from "@retail/core";
import { connect, type ConnectionOptions, type Database } from "./internal/connect";
import { translateAuthError } from "./errors";

/**
 * Who a request is acting as. The server builds this from a verified session; nothing the
 * browser sends is trusted (DATA_MODEL §2). Only `tenantId` is required.
 */
export interface RlsContext {
  tenantId: string;
  staffId?: string;
  sessionId?: string;
  deviceId?: string;
  /** Set when a platform admin acts inside a shop (break-glass); recorded in the audit log. */
  impersonatorId?: string;
  /** Proof that a manager approved this action with their PIN (DATA_MODEL `pin_verifications`). */
  pinVerificationId?: string;
}

/** Postgres settings read by the `private.ctx_*()` functions (migration 0001). Keep in sync. */
export const RLS_SETTINGS = {
  tenantId: "app.tenant_id",
  staffId: "app.staff_id",
  sessionId: "app.session_id",
  deviceId: "app.device_id",
  impersonatorId: "app.impersonator_id",
  pinVerificationId: "app.pin_verification_id",
} as const satisfies Record<keyof RlsContext, string>;

export class InvalidRlsContextError extends Error {
  constructor(field: string) {
    super(`Invalid RLS context: ${field} must be a UUID`);
    this.name = "InvalidRlsContextError";
  }
}

/** The handle passed to your query code. It is already scoped to one tenant. */
export type RlsTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** The handle for a verified account with no shop chosen yet: no shop data is visible through it. */
export type IdentityTransaction = RlsTransaction;

export interface RlsOptions {
  /**
   * Pass `true` for a transaction that will change data. It takes the tenant's audit lock
   * FIRST, before any row is touched. Without it, two write transactions that touch the same
   * rows in opposite orders can deadlock (each holds a row the other wants, plus the audit
   * lock the other needs); Postgres then aborts one with SQLSTATE 40P01. Costs nothing for a
   * transaction that writes anyway, because audited writes take that lock regardless.
   * Leave it off for read-only requests so they never queue behind writers.
   */
  write?: boolean;
}

export interface TenantDb {
  /**
   * Run `fn` in one transaction that can only see and change `ctx.tenantId`'s rows.
   * This is the ONLY way tenant code reaches the database.
   */
  rls<T>(ctx: RlsContext, fn: (tx: RlsTransaction) => Promise<T>, options?: RlsOptions): Promise<T>;
  /** For a verified account before it has chosen a shop (see `runWithIdentity`). */
  identity<T>(identity: Identity, fn: (tx: IdentityTransaction) => Promise<T>): Promise<T>;
  /** For a paired till BEFORE anyone has signed in (pairing, the staff list, PIN sign-in). */
  device<T>(fn: (tx: DeviceTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function assertValidContext(ctx: RlsContext): void {
  if (!isUuid(ctx.tenantId)) throw new InvalidRlsContextError("tenantId");
  for (const field of Object.keys(RLS_SETTINGS) as (keyof RlsContext)[]) {
    const value = ctx[field];
    if (value !== undefined && !isUuid(value)) throw new InvalidRlsContextError(field);
  }
  // A staff identity is only believable together with the sign-in that proves it. Without a
  // session id the request could never be revoked, so it is not accepted at all.
  if (ctx.staffId !== undefined && ctx.sessionId === undefined) {
    throw new InvalidRlsContextError("sessionId (required whenever staffId is given)");
  }
}

/** A verified login account, before any shop is chosen. The server fills this from a checked token. */
export interface Identity {
  authUserId: string;
  /** The account's verified email address; invitations are matched against it. */
  email: string;
}

/** Postgres settings read by `private.ctx_auth_user()` / `ctx_auth_email()` (migration 0006). Keep in sync. */
export const IDENTITY_SETTINGS = { authUserId: "app.auth_user_id", authEmail: "app.auth_email" } as const;

/** Enough to stop junk and control characters; the real proof of ownership is the verified token. */
const EMAIL_SHAPE = /^[^\s@\u0000-\u001f]+@[^\s@\u0000-\u001f]+\.[^\s@\u0000-\u001f]+$/;

export function assertValidIdentity(identity: Identity): void {
  if (!isUuid(identity.authUserId)) throw new InvalidRlsContextError("authUserId");
  if (identity.email.length > 254 || !EMAIL_SHAPE.test(identity.email)) throw new InvalidRlsContextError("email");
}

/**
 * 1. `set local role authenticated`: drop to the role whose access the policies describe.
 * 2. `set_config(..., true)`: publish who we are, for this transaction only. `local`
 *    settings vanish at commit or rollback, so a pooled connection never carries a previous
 *    request's identity into the next one.
 */
export async function runWithRls<T>(
  db: Database,
  ctx: RlsContext,
  fn: (tx: RlsTransaction) => Promise<T>,
  options: RlsOptions = {},
): Promise<T> {
  assertValidContext(ctx);
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role authenticated`);
    await tx.execute(sql`
      select
        set_config(${RLS_SETTINGS.tenantId}, ${ctx.tenantId}, true),
        set_config(${RLS_SETTINGS.staffId}, ${ctx.staffId ?? ""}, true),
        set_config(${RLS_SETTINGS.sessionId}, ${ctx.sessionId ?? ""}, true),
        set_config(${RLS_SETTINGS.deviceId}, ${ctx.deviceId ?? ""}, true),
        set_config(${RLS_SETTINGS.impersonatorId}, ${ctx.impersonatorId ?? ""}, true),
        set_config(${RLS_SETTINGS.pinVerificationId}, ${ctx.pinVerificationId ?? ""}, true)
    `);
    // The session must still be good, checked inside THIS transaction so there is no gap between
    // "checked" and "used": ended, expired, a suspended person or a closed shop all stop here.
    // (Platform and system code claims no session and is not checked.)
    if (ctx.sessionId !== undefined) {
      try {
        await tx.execute(sql`select private.assert_session_active()`);
      } catch (error) {
        throw translateAuthError(error);
      }
    }
    if (options.write) await tx.execute(sql`select audit.lock_tenant()`);
    return fn(tx);
  });
}

/**
 * Run `fn` as a verified ACCOUNT that has not chosen a shop yet: to list its shops, accept an
 * invitation or start a session. No shop is in scope, so tables show nothing; only the
 * deliberately narrow functions in migration 0006 (`app.my_shops`, `app.accept_invite`,
 * `app.start_session`) do anything useful here.
 */
export async function runWithIdentity<T>(
  db: Database,
  identity: Identity,
  fn: (tx: IdentityTransaction) => Promise<T>,
): Promise<T> {
  assertValidIdentity(identity);
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role authenticated`);
    await tx.execute(sql`
      select
        set_config(${IDENTITY_SETTINGS.authUserId}, ${identity.authUserId}, true),
        set_config(${IDENTITY_SETTINGS.authEmail}, ${identity.email}, true)
    `);
    try {
      return await fn(tx);
    } catch (error) {
      throw translateAuthError(error);
    }
  });
}

/** The handle for a till that has no account and no shop context yet: only the narrow device functions work. */
export type DeviceTransaction = RlsTransaction;

/**
 * Run `fn` for a till that is pairing or signing someone in. Nothing is claimed: no shop, no
 * account. Only the deliberately narrow functions in migration 0008 (`app.pair_device`,
 * `app.device_info`, `app.device_staff`, `app.pin_attempt_begin`, `app.pin_sign_in_finish`) do
 * anything here, and each proves itself with a secret (a pairing code, a device token, a PIN).
 *
 * IMPORTANT: a failed guess must be RETURNED, never thrown. Throwing rolls the transaction back,
 * and the failure counter with it. The helpers in devices.ts follow this rule.
 */
export async function runAsDevice<T>(db: Database, fn: (tx: DeviceTransaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local role authenticated`);
    try {
      return await fn(tx);
    } catch (error) {
      throw translateAuthError(error);
    }
  });
}

/** Connect as the shop-app login (`retail_app`, which cannot bypass row-level security). */
export function createTenantDb(url: string, options?: ConnectionOptions): TenantDb {
  const { client, db } = connect(url, options);
  return {
    rls: (ctx, fn, options) => runWithRls(db, ctx, fn, options),
    identity: (identity, fn) => runWithIdentity(db, identity, fn),
    device: (fn) => runAsDevice(db, fn),
    close: () => client.end(),
  };
}
