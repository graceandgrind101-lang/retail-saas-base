import { z } from "zod";
import { isPermissionKey, isUuid, uuidv7 } from "@retail/core";
import { createStaff, removeOverride, setOverride, setRolePermission, setStaffRole, setStaffStatus, type TenantDb } from "@retail/db";
import { clearedSessionCookieHeader } from "../auth/cookie";
import { HttpError, apiErrorResponse, jsonResponse, readJsonBody, readSessionContext, requireSameOrigin } from "../http";

/**
 * Staff, roles and permission changes (Phase A task A9), as plain functions from `Request` to
 * `Response`. Every rule (who may grant what, not your own, not above you, never the last owner)
 * is enforced by the database; these endpoints only validate the shape and pass the request on
 * in the signed-in person's own name.
 */

export interface PermissionDeps {
  db: TenantDb;
  sessionSecret: string;
  appUrl: string;
  now?: () => number;
}

const uuid = z.string().refine(isUuid, "must be a UUID");
const key = z.string().refine(isPermissionKey, "unknown permission");
const createBody = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    roleId: uuid,
    phone: z.string().trim().min(3).max(32).optional(),
    branchIds: z.array(uuid).max(50).optional(),
  })
  .strict();
const roleBody = z.object({ staffId: uuid, roleId: uuid }).strict();
const statusBody = z.object({ staffId: uuid, status: z.enum(["active", "suspended", "archived"]) }).strict();
const overrideBody = z.object({ staffId: uuid, key, effect: z.enum(["allow", "deny"]), reason: z.string().trim().min(1).max(300) }).strict();
const removeBody = z.object({ staffId: uuid, key }).strict();
const rolePermissionBody = z.object({ roleId: uuid, key, granted: z.boolean() }).strict();

export function createPermissionHandlers(deps: PermissionDeps) {
  const now = deps.now ?? Date.now;
  const clearSession = { "set-cookie": clearedSessionCookieHeader(deps.appUrl) };

  async function requireSession(request: Request) {
    const context = await readSessionContext(request, { appUrl: deps.appUrl, sessionSecret: deps.sessionSecret, nowSeconds: Math.floor(now() / 1000) });
    if (!context) throw new HttpError(401, "unauthenticated");
    return context;
  }

  const guard = (fn: () => Promise<Response>): Promise<Response> => fn().catch((error: unknown) => apiErrorResponse(error, "permission endpoint", clearSession));

  return {
    /** POST { displayName, roleId, phone?, branchIds? }: add a person with no login account (give them a PIN next). */
    createStaff: (request: Request) =>
      guard(async () => {
        requireSameOrigin(request, deps.appUrl);
        const context = await requireSession(request);
        const body = await readJsonBody(request, createBody);
        const id = uuidv7();
        await deps.db.rls(
          context,
          (tx) => createStaff(tx, { id, displayName: body.displayName, roleId: body.roleId, ...(body.phone ? { phone: body.phone } : {}), ...(body.branchIds ? { branchIds: body.branchIds } : {}) }),
          { write: true },
        );
        return jsonResponse(200, { id });
      }),

    /** POST { staffId, roleId }: give a person another role. */
    setStaffRole: (request: Request) =>
      guard(async () => {
        requireSameOrigin(request, deps.appUrl);
        const context = await requireSession(request);
        const body = await readJsonBody(request, roleBody);
        await deps.db.rls(context, (tx) => setStaffRole(tx, body.staffId, body.roleId), { write: true });
        return jsonResponse(200, { changed: true });
      }),

    /** POST { staffId, status }: suspend, reinstate or archive a person. */
    setStaffStatus: (request: Request) =>
      guard(async () => {
        requireSameOrigin(request, deps.appUrl);
        const context = await requireSession(request);
        const body = await readJsonBody(request, statusBody);
        await deps.db.rls(context, (tx) => setStaffStatus(tx, body.staffId, body.status), { write: true });
        return jsonResponse(200, { changed: true });
      }),

    /** POST { staffId, key, effect, reason }: a personal exception. */
    setOverride: (request: Request) =>
      guard(async () => {
        requireSameOrigin(request, deps.appUrl);
        const context = await requireSession(request);
        const body = await readJsonBody(request, overrideBody);
        await deps.db.rls(context, (tx) => setOverride(tx, body), { write: true });
        return jsonResponse(200, { changed: true });
      }),

    /** POST { staffId, key }: take a personal exception away. */
    removeOverride: (request: Request) =>
      guard(async () => {
        requireSameOrigin(request, deps.appUrl);
        const context = await requireSession(request);
        const body = await readJsonBody(request, removeBody);
        const removed = await deps.db.rls(context, (tx) => removeOverride(tx, body), { write: true });
        return jsonResponse(200, { removed });
      }),

    /** POST { roleId, key, granted }: give a custom role a key, or take it away. */
    setRolePermission: (request: Request) =>
      guard(async () => {
        requireSameOrigin(request, deps.appUrl);
        const context = await requireSession(request);
        const body = await readJsonBody(request, rolePermissionBody);
        await deps.db.rls(context, (tx) => setRolePermission(tx, body), { write: true });
        return jsonResponse(200, { changed: true });
      }),
  };
}

export type PermissionHandlers = ReturnType<typeof createPermissionHandlers>;
