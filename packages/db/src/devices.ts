import { sql } from "drizzle-orm";
import {
  SESSION_HOURS,
  STEP_UP_VALID_SECONDS,
  checkNewPin,
  formatPairingCode,
  generateDeviceToken,
  generatePairingCode,
  hashPin,
  hmacHex,
  isPinShape,
  isWellFormedDeviceToken,
  normalizePairingCode,
  uuidv7,
  verifyPin,
  type PinProblem,
} from "@retail/core";
import { translateAuthError } from "./errors";
import type { DeviceTransaction, RlsTransaction } from "./rls";

/**
 * Paired devices, PIN sign-in and one-time PIN approvals (task A8). Thin, typed doors to the
 * functions in migration 0008, plus the parts that need the server's secrets (the peppers).
 *
 * Failed guesses are RETURNED as `{ ok: false, reason }`, never thrown: a thrown error rolls the
 * transaction back and takes the failure counter with it (see `runAsDevice`).
 */

export interface Peppers {
  /** Protects pairing codes and device tokens at rest (env DEVICE_TOKEN_PEPPER). */
  devicePepper: string;
  /** Protects PINs at rest (env PIN_PEPPER). */
  pinPepper: string;
}

// Separate prefixes so a value of one kind can never be mistaken for the other.
export const hashPairingCode = (pepper: string, code: string): Promise<string> => hmacHex(pepper, `pairing-code:${code}`);
export const hashDeviceToken = (pepper: string, token: string): Promise<string> => hmacHex(pepper, `device-token:${token}`);
const pairingCodeHash = hashPairingCode;
const deviceTokenHash = hashDeviceToken;

export type DeviceKind = "pos" | "phone" | "tablet" | "desktop";
export const DEVICE_KINDS: readonly DeviceKind[] = ["pos", "phone", "tablet", "desktop"];

// ---------- pairing ----------

/** An owner or manager makes a one-time code for a new device. Shown as a QR or XXXX-XXXX; valid 10 minutes. */
export async function createPairingCode(
  tx: RlsTransaction,
  input: { branchId: string; devicePepper: string },
): Promise<{ code: string; expiresAt: Date }> {
  const code = generatePairingCode();
  const rows = await tx.execute<{ expires_at: string | Date }>(sql`
    select app.create_pairing_code(${uuidv7()}::uuid, ${input.branchId}::uuid, ${await pairingCodeHash(input.devicePepper, code)}) as expires_at`);
  const row = rows[0];
  if (!row) throw new Error("app.create_pairing_code returned nothing");
  return { code: formatPairingCode(code), expiresAt: new Date(row.expires_at) };
}

export type PairResult =
  | { ok: true; deviceId: string; tenantId: string; branchId: string; deviceToken: string }
  | { ok: false; reason: "invalid" | "rate_limited" };

/**
 * The new device presents the code. On success it receives its secret token, ONCE (only the
 * token's HMAC is kept). `rateKey` identifies the caller (an address): guesses are capped per
 * caller and across the platform.
 */
export async function pairDevice(
  tx: DeviceTransaction,
  input: { code: string; name: string; kind: DeviceKind; userAgent?: string; rateKey: string; devicePepper: string },
): Promise<PairResult> {
  const code = normalizePairingCode(input.code);
  const name = input.name.trim();
  if (!code || name === "" || name.length > 60 || !DEVICE_KINDS.includes(input.kind)) {
    // Cannot be a real code (or a usable name), so it cannot be a guess either: no need to count it.
    return { ok: false, reason: "invalid" };
  }
  const deviceToken = generateDeviceToken();
  const deviceId = uuidv7();
  const rows = await tx.execute<{ status: string; tenant_id: string | null; branch_id: string | null }>(sql`
    select status, tenant_id, branch_id from app.pair_device(
      ${await pairingCodeHash(input.devicePepper, code)}, ${deviceId}::uuid, ${await deviceTokenHash(input.devicePepper, deviceToken)},
      ${name}, ${input.kind}, ${input.userAgent ?? null}, ${input.rateKey})`);
  const row = rows[0];
  if (!row) throw new Error("app.pair_device returned nothing");
  if (row.status === "ok" && row.tenant_id && row.branch_id) {
    return { ok: true, deviceId, tenantId: row.tenant_id, branchId: row.branch_id, deviceToken };
  }
  return { ok: false, reason: row.status === "rate_limited" ? "rate_limited" : "invalid" };
}

/** Revoke a device: no more PIN sign-ins on it, and its open sessions end at once. Returns false if already revoked. */
export async function revokeDevice(tx: RlsTransaction, deviceId: string): Promise<boolean> {
  const rows = await tx.execute<{ revoked: boolean }>(sql`select app.revoke_device(${deviceId}::uuid) as revoked`);
  return rows[0]?.revoked === true;
}

/** Open a locked till early (owner or manager). Returns false for an unknown or revoked device. */
export async function unlockDevice(tx: RlsTransaction, deviceId: string): Promise<boolean> {
  const rows = await tx.execute<{ unlocked: boolean }>(sql`select app.unlock_device(${deviceId}::uuid) as unlocked`);
  return rows[0]?.unlocked === true;
}

/** The till the signed-in person is using (null in the admin app). */
export async function getMyDevice(tx: RlsTransaction): Promise<{ id: string; name: string } | null> {
  const rows = await tx.execute<{ id: string; name: string }>(sql`select id, name from app.devices where id = private.ctx_device()`);
  return rows[0] ?? null;
}

// ---------- what a device may ask before anyone signs in ----------

export interface DeviceInfo {
  deviceId: string;
  tenantId: string;
  branchId: string;
  deviceName: string;
  tenantSlug: string;
  tenantDisplayName: Record<string, string>;
  lockedUntil: Date | null;
}

/** Who this device is, or null when the token is unknown or revoked (the till should ask to be paired again). */
export async function getDeviceInfo(
  tx: DeviceTransaction,
  input: { deviceToken: string; devicePepper: string },
): Promise<DeviceInfo | null> {
  if (!isWellFormedDeviceToken(input.deviceToken)) return null;
  const rows = await tx.execute<{
    device_id: string;
    tenant_id: string;
    branch_id: string;
    device_name: string;
    tenant_slug: string;
    tenant_display_name: Record<string, string>;
    locked_until: string | Date | null;
  }>(sql`select * from app.device_info(${await deviceTokenHash(input.devicePepper, input.deviceToken)})`);
  const r = rows[0];
  if (!r) return null;
  return {
    deviceId: r.device_id,
    tenantId: r.tenant_id,
    branchId: r.branch_id,
    deviceName: r.device_name,
    tenantSlug: r.tenant_slug,
    tenantDisplayName: r.tenant_display_name,
    lockedUntil: r.locked_until ? new Date(r.locked_until) : null,
  };
}

export interface DeviceStaffMember {
  staffId: string;
  displayName: string;
  locked: boolean;
}

/** The people who can sign in at this till. Empty for an unknown or revoked device. */
export async function listDeviceStaff(
  tx: DeviceTransaction,
  input: { deviceToken: string; devicePepper: string },
): Promise<DeviceStaffMember[]> {
  if (!isWellFormedDeviceToken(input.deviceToken)) return [];
  const rows = await tx.execute<{ staff_id: string; display_name: string; locked: boolean }>(
    sql`select staff_id, display_name, locked from app.device_staff(${await deviceTokenHash(input.devicePepper, input.deviceToken)})`,
  );
  return rows.map((r) => ({ staffId: r.staff_id, displayName: r.display_name, locked: r.locked }));
}

// ---------- PIN sign-in ----------

export type PinSignInResult =
  | { ok: true; sessionId: string; staffId: string; tenantId: string; deviceId: string; expiresAt: Date }
  | { ok: false; reason: "wrong_pin" | "locked" | "no_device" | "cannot_sign_in" };

/**
 * A person types their PIN at a paired till. Everything happens in ONE transaction: the attempt
 * is counted as a failure first, a correct PIN clears it and opens the session (12 hours).
 * Wrong PINs, locks and unknown devices are returned, not thrown (see the note at the top).
 */
export async function pinSignIn(
  tx: DeviceTransaction,
  input: { deviceToken: string; staffId: string; pin: string; peppers: Peppers; hours?: number; hashFn?: typeof verifyPin },
): Promise<PinSignInResult> {
  if (!isWellFormedDeviceToken(input.deviceToken)) return { ok: false, reason: "no_device" };
  const tokenHash = await deviceTokenHash(input.peppers.devicePepper, input.deviceToken);
  const begun = await tx.execute<{ status: string; pin_hash: string | null; tenant_id: string | null; device_id: string | null }>(
    sql`select status, pin_hash, tenant_id, device_id from app.pin_attempt_begin(${tokenHash}, ${input.staffId}::uuid)`,
  );
  const b = begun[0];
  if (!b) throw new Error("app.pin_attempt_begin returned nothing");
  if (b.status !== "ok" || !b.pin_hash) {
    return { ok: false, reason: b.status === "locked" || b.status === "no_device" ? b.status : "cannot_sign_in" };
  }
  // A malformed PIN is a wrong PIN (it was already counted); it just skips the slow hash.
  const correct = isPinShape(input.pin) && (await (input.hashFn ?? verifyPin)(input.pin, b.pin_hash, input.peppers.pinPepper));
  if (!correct) return { ok: false, reason: "wrong_pin" };

  const sessionId = uuidv7();
  const expiresAt = new Date(Date.now() + (input.hours ?? SESSION_HOURS.pos) * 3_600_000);
  const finished = await tx.execute<{ tenant_id: string; staff_id: string; device_id: string }>(sql`
    select tenant_id, staff_id, device_id from app.pin_sign_in_finish(
      ${tokenHash}, ${input.staffId}::uuid, ${sessionId}::uuid, ${expiresAt.toISOString()}::timestamptz)`);
  const f = finished[0];
  if (!f) throw new Error("app.pin_sign_in_finish returned nothing");
  return { ok: true, sessionId, staffId: f.staff_id, tenantId: f.tenant_id, deviceId: f.device_id, expiresAt };
}

// ---------- setting a PIN ----------

export class PinTooWeakError extends Error {
  readonly problem: PinProblem;
  constructor(problem: PinProblem) {
    super(`This PIN is not acceptable: ${problem}`);
    this.name = "PinTooWeakError";
    this.problem = problem;
  }
}

/** Set a PIN: your own, or (owner or manager) someone else's; see the rules in migration 0008. Run with `write: true`. */
export async function setStaffPin(
  tx: RlsTransaction,
  input: { staffId: string; pin: string; pinPepper: string; iterations?: number },
): Promise<void> {
  const problem = checkNewPin(input.pin);
  if (problem) throw new PinTooWeakError(problem);
  const stored = await hashPin(input.pin, input.pinPepper, input.iterations === undefined ? {} : { iterations: input.iterations });
  await tx.execute(sql`select app.set_staff_pin(${input.staffId}::uuid, ${stored})`);
}

// ---------- one-time PIN approval ----------

export type StepUpResult =
  | { ok: true; verificationId: string; expiresAt: Date }
  | { ok: false; reason: "wrong_pin" | "locked" | "cannot_approve" };

export const STEP_UP_SECONDS = STEP_UP_VALID_SECONDS;

/**
 * Someone (often a manager) types their PIN to approve ONE action requested in the signed-in
 * request's session. The result is an id good for two minutes, for this action (and this one
 * record, if given), that the action then spends with `consumeStepUp`. Run with `write: true`.
 */
export async function requestStepUp(
  tx: RlsTransaction,
  input: { approverId: string; pin: string; actionKey: string; entityId?: string; pinPepper: string },
): Promise<StepUpResult> {
  const begun = await tx.execute<{ status: string; pin_hash: string | null }>(
    sql`select status, pin_hash from app.step_up_begin(${input.approverId}::uuid, ${input.actionKey})`,
  );
  const b = begun[0];
  if (!b) throw new Error("app.step_up_begin returned nothing");
  if (b.status !== "ok" || !b.pin_hash) return { ok: false, reason: b.status === "locked" ? "locked" : "cannot_approve" };
  if (!isPinShape(input.pin) || !(await verifyPin(input.pin, b.pin_hash, input.pinPepper))) return { ok: false, reason: "wrong_pin" };

  const verificationId = uuidv7();
  const rows = await tx.execute<{ expires_at: string | Date }>(sql`
    select app.step_up_finish(${verificationId}::uuid, ${input.approverId}::uuid, ${input.actionKey}, ${input.entityId ?? null}::uuid) as expires_at`);
  const row = rows[0];
  if (!row) throw new Error("app.step_up_finish returned nothing");
  return { ok: true, verificationId, expiresAt: new Date(row.expires_at) };
}

/**
 * Spend an approval. Returns whose PIN approved it; throws `StepUpInvalidError` if it is unknown,
 * already used, expired, for another action or record, or was not asked for by this session.
 * From here to the end of the transaction the audit log records the approval's id.
 */
export async function consumeStepUp(
  tx: RlsTransaction,
  input: { verificationId: string; actionKey: string; entityId?: string },
): Promise<{ approverId: string }> {
  let rows: { approver: string }[];
  try {
    rows = await tx.execute<{ approver: string }>(
      sql`select app.consume_step_up(${input.verificationId}::uuid, ${input.actionKey}, ${input.entityId ?? null}::uuid) as approver`,
    );
  } catch (error) {
    throw translateAuthError(error);
  }
  const row = rows[0];
  if (!row) throw new Error("app.consume_step_up returned nothing");
  return { approverId: row.approver };
}
