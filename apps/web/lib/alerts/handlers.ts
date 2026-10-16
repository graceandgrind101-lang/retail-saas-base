import { z } from "zod";
import { ALERT_CATEGORIES, ALERT_STATUSES, isUuid } from "@retail/core";
import { countOpenAlerts, listAlerts, setAlertStatus, type TenantDb } from "@retail/db";
import { clearedSessionCookieHeader } from "../auth/cookie";
import { HttpError, apiErrorResponse, jsonResponse, readJsonBody, readSessionContext, requireSameOrigin } from "../http";

/**
 * Alerts (Phase A task A10), as plain functions from `Request` to `Response`. Reading needs
 * `alert:view` and closing needs `alert:resolve`; both are enforced against the database.
 */

export interface AlertDeps {
  db: TenantDb;
  sessionSecret: string;
  appUrl: string;
  now?: () => number;
}

const statusBody = z
  .object({
    alertId: z.string().refine(isUuid, "must be a UUID"),
    status: z.enum(["ack", "resolved", "dismissed"]),
    note: z.string().max(500).optional(),
  })
  .strict();

/** `?status=new,ack&category=fraud&limit=20&offset=0`, every part optional; junk is a 400, never ignored. */
const listQuery = z
  .object({
    status: z.array(z.enum(ALERT_STATUSES)).min(1).optional(),
    category: z.array(z.enum(ALERT_CATEGORIES)).min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).max(100_000).optional(),
  })
  .strict();

function parseQuery(url: URL) {
  const raw: Record<string, unknown> = {};
  for (const [name, value] of url.searchParams) {
    if (name in raw) throw new HttpError(400, "bad_request");
    raw[name] = name === "status" || name === "category" ? value.split(",") : value;
  }
  const parsed = listQuery.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "bad_request");
  return parsed.data;
}

export function createAlertHandlers(deps: AlertDeps) {
  const now = deps.now ?? Date.now;
  const clearSession = { "set-cookie": clearedSessionCookieHeader(deps.appUrl) };

  async function requireSession(request: Request) {
    const context = await readSessionContext(request, { appUrl: deps.appUrl, sessionSecret: deps.sessionSecret, nowSeconds: Math.floor(now() / 1000) });
    if (!context) throw new HttpError(401, "unauthenticated");
    return context;
  }

  const guard = (fn: () => Promise<Response>): Promise<Response> => fn().catch((error: unknown) => apiErrorResponse(error, "alert endpoint", clearSession));

  return {
    /** GET: the alerts (open ones by default) and how many are open per category. */
    list: (request: Request) =>
      guard(async () => {
        const context = await requireSession(request);
        const query = parseQuery(new URL(request.url));
        const { alerts, counts } = await deps.db.rls(context, async (tx) => ({
          alerts: await listAlerts(tx, {
            ...(query.status ? { statuses: query.status } : {}),
            ...(query.category ? { categories: query.category } : {}),
            ...(query.limit ? { limit: query.limit } : {}),
            ...(query.offset ? { offset: query.offset } : {}),
          }),
          counts: await countOpenAlerts(tx),
        }));
        return jsonResponse(200, {
          counts,
          alerts: alerts.map((a) => ({
            id: a.id,
            category: a.category,
            rule: a.ruleKey,
            severity: a.severity,
            branchId: a.branchId,
            entity: a.entityType ? { type: a.entityType, id: a.entityId } : null,
            payload: a.payload,
            status: a.status,
            assigneeId: a.assigneeStaffId,
            note: a.resolutionNote,
            resolvedBy: a.resolvedBy,
            resolvedAt: a.resolvedAt?.toISOString() ?? null,
            createdAt: a.createdAt.toISOString(),
          })),
        });
      }),

    /** POST { alertId, status, note? }: acknowledge, resolve or dismiss. */
    setStatus: (request: Request) =>
      guard(async () => {
        requireSameOrigin(request, deps.appUrl);
        const context = await requireSession(request);
        const body = await readJsonBody(request, statusBody);
        await deps.db.rls(context, (tx) => setAlertStatus(tx, { alertId: body.alertId, status: body.status, ...(body.note ? { note: body.note } : {}) }), { write: true });
        return jsonResponse(200, { changed: true });
      }),
  };
}

export type AlertHandlers = ReturnType<typeof createAlertHandlers>;
