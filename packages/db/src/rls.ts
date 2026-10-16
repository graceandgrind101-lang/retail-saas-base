import { sql } from "drizzle-orm";
import { isUuid } from "@retail/core";
import { connect, type ConnectionOptions, type Database } from "./internal/connect";

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

export interface TenantDb {
  /**
   * Run `fn` in one transaction that can only see and change `ctx.tenantId`'s rows.
   * This is the ONLY way tenant code reaches the database.
   */
  rls<T>(ctx: RlsContext, fn: (tx: RlsTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function assertValidContext(ctx: RlsContext): void {
  if (!isUuid(ctx.tenantId)) throw new InvalidRlsContextError("tenantId");
  for (const field of Object.keys(RLS_SETTINGS) as (keyof RlsContext)[]) {
    const value = ctx[field];
    if (value !== undefined && !isUuid(value)) throw new InvalidRlsContextError(field);
  }
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
    // TODO(A8): before running `fn`, verify the session is active and the staff member is
    // `active` in this tenant, so a suspended cashier is locked out on their next request
    // (DATA_MODEL §2 step 3). Needs the staff and session tables from A7/A8.
    return fn(tx);
  });
}

/** Connect as the shop-app login (`retail_app`, which cannot bypass row-level security). */
export function createTenantDb(url: string, options?: ConnectionOptions): TenantDb {
  const { client, db } = connect(url, options);
  return {
    rls: (ctx, fn) => runWithRls(db, ctx, fn),
    close: () => client.end(),
  };
}
