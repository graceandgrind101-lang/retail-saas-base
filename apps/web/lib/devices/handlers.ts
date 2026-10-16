import { z } from "zod";
import { isUuid, parseCookieHeader, signSessionCookie } from "@retail/core";
import {
  DEVICE_KINDS,
  PinTooWeakError,
  SessionEndedError,
  StepUpInvalidError,
  createPairingCode,
  getDeviceInfo,
  isShopReadOnlyError,
  listDeviceStaff,
  pairDevice,
  pgErrorCode,
  pinSignIn,
  requestStepUp,
  revokeDevice,
  setStaffPin,
  unlockDevice,
  type Peppers,
  type TenantDb,
} from "@retail/db";
import {
  clearedDeviceCookieHeader,
  clearedSessionCookieHeader,
  deviceCookieHeader,
  deviceCookieName,
  sessionCookieHeader,
} from "../auth/cookie";
import { HttpError, jsonResponse, readJsonBody, readSessionContext, requireSameOrigin } from "../http";

/**
 * The device and PIN endpoints (Phase A task A8), as plain functions from `Request` to `Response`
 * (the route files are one-line wrappers; tests drive them with real requests).
 *
 * Who is who:
 *  - pairing a device needs an owner or manager's shop session (to make the code) and then only
 *    the code (on the new device);
 *  - PIN sign-in needs the device cookie, which only a paired device holds;
 *  - everything else needs the shop session cookie.
 * The browser is only ever told a short, fixed error code.
 */

export interface DeviceDeps {
  db: TenantDb;
  peppers: Peppers;
  sessionSecret: string;
  appUrl: string;
  now?: () => number;
}

const uuid = z.string().refine(isUuid, "must be a UUID");
const pin = z.string().regex(/^[0-9]{4,6}$/);
const codeBody = z.object({ branchId: uuid }).strict();
const pairBody = z
  .object({ code: z.string().min(8).max(16), name: z.string().trim().min(1).max(60), kind: z.enum(DEVICE_KINDS as [string, ...string[]]) })
  .strict();
const signInBody = z.object({ staffId: uuid, pin }).strict();
const deviceIdBody = z.object({ deviceId: uuid }).strict();
const setPinBody = z.object({ staffId: uuid, pin: z.string().max(12) }).strict();
const stepUpBody = z
  .object({ approverId: uuid, pin, actionKey: z.string().regex(/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/).max(80), entityId: uuid.optional() })
  .strict();

/**
 * Who is calling, for the guess limits. Behind Cloudflare the connecting address is trustworthy;
 * elsewhere the forwarded header can be forged, which only weakens the PER-CALLER cap. The
 * platform-wide cap in the database does not depend on it.
 */
export function clientKey(request: Request): string {
  const connecting = request.headers.get("cf-connecting-ip")?.trim();
  if (connecting) return connecting.slice(0, 64);
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (forwarded || "unknown").slice(0, 64);
}

export function createDeviceHandlers(deps: DeviceDeps) {
  const now = deps.now ?? Date.now;
  const nowSeconds = () => Math.floor(now() / 1000);
  const clearSession = { "set-cookie": clearedSessionCookieHeader(deps.appUrl) };

  const sessionContext = (request: Request) =>
    readSessionContext(request, { appUrl: deps.appUrl, sessionSecret: deps.sessionSecret, nowSeconds: nowSeconds() });

  async function requireSession(request: Request) {
    const context = await sessionContext(request);
    if (!context) throw new HttpError(401, "unauthenticated");
    return context;
  }

  const deviceToken = (request: Request): string | null =>
    parseCookieHeader(request.headers.get("cookie"))[deviceCookieName(deps.appUrl)] ?? null;

  function errorResponse(error: unknown): Response {
    if (error instanceof HttpError) return jsonResponse(error.status, { error: error.code });
    if (error instanceof SessionEndedError) return jsonResponse(401, { error: "session_ended" }, clearSession);
    if (error instanceof StepUpInvalidError) return jsonResponse(403, { error: "approval_invalid" });
    if (error instanceof PinTooWeakError) return jsonResponse(400, { error: "pin_weak", problem: error.problem });
    if (isShopReadOnlyError(error)) return jsonResponse(409, { error: "shop_read_only" });
    switch (pgErrorCode(error)) {
      case "42501":
        return jsonResponse(403, { error: "forbidden" });
      case "23514":
        return jsonResponse(400, { error: "bad_request" });
      default:
        // Log the kind of failure only: messages can carry data.
        console.error("device endpoint failed:", error instanceof Error ? error.name : "unknown error");
        return jsonResponse(500, { error: "server_error" });
    }
  }

  const guard = (fn: () => Promise<Response>): Promise<Response> => fn().catch(errorResponse);

  return {
    /** POST { branchId }: an owner or manager makes a one-time pairing code for a new device. */
    createPairingCode: (request: Request) =>
      guard(async () => {
        requireSameOrigin(request, deps.appUrl);
        const context = await requireSession(request);
        const { branchId } = await readJsonBody(request, codeBody);
        const made = await deps.db.rls(context, (tx) => createPairingCode(tx, { branchId, devicePepper: deps.peppers.devicePepper }), { write: true });
        return jsonResponse(200, { code: made.code, expiresAt: made.expiresAt.toISOString() });
      }),

    /** POST { code, name, kind }: the NEW device presents the code. Sets the device cookie; the token is never in the body. */
    pairDevice: (request: Request) =>
      guard(async () => {
        requireSameOrigin(request, deps.appUrl);
        const body = await readJsonBody(request, pairBody);
        const result = await deps.db.device((tx) =>
          pairDevice(tx, {
            code: body.code,
            name: body.name,
            kind: body.kind as (typeof DEVICE_KINDS)[number],
            userAgent: request.headers.get("user-agent") ?? "",
            rateKey: clientKey(request),
            devicePepper: deps.peppers.devicePepper,
          }),
        );
        if (!result.ok) {
          return result.reason === "rate_limited"
            ? jsonResponse(429, { error: "rate_limited" })
            : jsonResponse(400, { error: "pairing_invalid" });
        }
        return jsonResponse(
          200,
          { deviceId: result.deviceId, tenantId: result.tenantId, branchId: result.branchId },
          { "set-cookie": deviceCookieHeader(deps.appUrl, result.deviceToken) },
        );
      }),

    /** GET: what the till shows before anyone signs in: this device, its shop, and who may sign in. */
    deviceStatus: (request: Request) =>
      guard(async () => {
        const token = deviceToken(request);
        const unknown = () => jsonResponse(401, { error: "device_unknown" }, token ? { "set-cookie": clearedDeviceCookieHeader(deps.appUrl) } : {});
        if (!token) return unknown();
        const { info, staff } = await deps.db.device(async (tx) => ({
          info: await getDeviceInfo(tx, { deviceToken: token, devicePepper: deps.peppers.devicePepper }),
          staff: await listDeviceStaff(tx, { deviceToken: token, devicePepper: deps.peppers.devicePepper }),
        }));
        if (!info) return unknown();
        return jsonResponse(200, {
          device: { id: info.deviceId, name: info.deviceName, lockedUntil: info.lockedUntil?.toISOString() ?? null },
          shop: { slug: info.tenantSlug, name: info.tenantDisplayName },
          staff: staff.map((s) => ({ id: s.staffId, name: s.displayName, locked: s.locked })),
        });
      }),

    /** POST { staffId, pin }: sign in at this till. Sets the shop session cookie (12 hours). */
    pinSignIn: (request: Request) =>
      guard(async () => {
        requireSameOrigin(request, deps.appUrl);
        const token = deviceToken(request);
        if (!token) return jsonResponse(401, { error: "device_unknown" });
        const body = await readJsonBody(request, signInBody);
        const result = await deps.db.device((tx) => pinSignIn(tx, { deviceToken: token, staffId: body.staffId, pin: body.pin, peppers: deps.peppers }));
        if (!result.ok) {
          switch (result.reason) {
            case "wrong_pin":
              return jsonResponse(401, { error: "wrong_pin" });
            case "locked":
              return jsonResponse(423, { error: "locked" });
            case "no_device":
              return jsonResponse(401, { error: "device_unknown" }, { "set-cookie": clearedDeviceCookieHeader(deps.appUrl) });
            default:
              return jsonResponse(403, { error: "cannot_sign_in" });
          }
        }
        const expiresAtSeconds = Math.floor(result.expiresAt.getTime() / 1000);
        const cookie = await signSessionCookie(
          { tenantId: result.tenantId, staffId: result.staffId, sessionId: result.sessionId, deviceId: result.deviceId, expiresAt: expiresAtSeconds },
          deps.sessionSecret,
        );
        return jsonResponse(
          200,
          { tenantId: result.tenantId, expiresAt: result.expiresAt.toISOString() },
          { "set-cookie": sessionCookieHeader(deps.appUrl, cookie, expiresAtSeconds - now() / 1000) },
        );
      }),

    /** POST { deviceId }: owner or manager revokes a till. Its sign-ins end at once. */
    revokeDevice: (request: Request) =>
      guard(async () => {
        requireSameOrigin(request, deps.appUrl);
        const context = await requireSession(request);
        const { deviceId } = await readJsonBody(request, deviceIdBody);
        const revoked = await deps.db.rls(context, (tx) => revokeDevice(tx, deviceId), { write: true });
        return jsonResponse(200, { revoked });
      }),

    /** POST { deviceId }: owner or manager opens a locked till early. */
    unlockDevice: (request: Request) =>
      guard(async () => {
        requireSameOrigin(request, deps.appUrl);
        const context = await requireSession(request);
        const { deviceId } = await readJsonBody(request, deviceIdBody);
        const unlocked = await deps.db.rls(context, (tx) => unlockDevice(tx, deviceId), { write: true });
        return jsonResponse(200, { unlocked });
      }),

    /** POST { staffId, pin }: set a PIN (your own, or, as owner or manager, someone else's). */
    setPin: (request: Request) =>
      guard(async () => {
        requireSameOrigin(request, deps.appUrl);
        const context = await requireSession(request);
        const body = await readJsonBody(request, setPinBody);
        await deps.db.rls(context, (tx) => setStaffPin(tx, { staffId: body.staffId, pin: body.pin, pinPepper: deps.peppers.pinPepper }), { write: true });
        return jsonResponse(200, { set: true });
      }),

    /** POST { approverId, pin, actionKey, entityId? }: someone types their PIN to approve one action. */
    stepUp: (request: Request) =>
      guard(async () => {
        requireSameOrigin(request, deps.appUrl);
        const context = await requireSession(request);
        const body = await readJsonBody(request, stepUpBody);
        const result = await deps.db.rls(
          context,
          (tx) =>
            requestStepUp(tx, {
              approverId: body.approverId,
              pin: body.pin,
              actionKey: body.actionKey,
              ...(body.entityId ? { entityId: body.entityId } : {}),
              pinPepper: deps.peppers.pinPepper,
            }),
          { write: true },
        );
        if (!result.ok) {
          return result.reason === "locked" ? jsonResponse(423, { error: "locked" }) : jsonResponse(403, { error: result.reason });
        }
        return jsonResponse(200, { verificationId: result.verificationId, expiresAt: result.expiresAt.toISOString() });
      }),
  };
}

export type DeviceHandlers = ReturnType<typeof createDeviceHandlers>;
