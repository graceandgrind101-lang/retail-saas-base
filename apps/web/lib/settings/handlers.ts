import { z } from "zod";
import { isUuid } from "@retail/core";
import { InvalidSettingError, getSettings, requirePermission, saveSetting, type TenantDb } from "@retail/db";
import { isLocale } from "@retail/i18n";
import { clearedSessionCookieHeader } from "../auth/cookie";
import { HttpError, apiErrorResponse, jsonResponse, readJsonBody, readSessionContext, requireSameOrigin } from "../http";

/**
 * Settings (Phase A task A14), as plain functions from `Request` to `Response`. Reading needs
 * `settings:view`, saving needs `settings:edit`. Whether a setting may be saved at all (locked,
 * hidden), and the PIN approval a sensitive one needs, are decided by the database function, so
 * no way of making the request gets around them.
 */

export interface SettingsDeps {
  db: TenantDb;
  sessionSecret: string;
  appUrl: string;
  now?: () => number;
}

const saveBody = z
  .object({
    key: z.string().max(80),
    value: z.unknown(),
    verificationId: z.string().refine(isUuid, "must be a UUID").optional(),
  })
  .strict();

export function createSettingsHandlers(deps: SettingsDeps) {
  const now = deps.now ?? Date.now;
  const clearSession = { "set-cookie": clearedSessionCookieHeader(deps.appUrl) };

  async function requireSession(request: Request) {
    const context = await readSessionContext(request, { appUrl: deps.appUrl, sessionSecret: deps.sessionSecret, nowSeconds: Math.floor(now() / 1000) });
    if (!context) throw new HttpError(401, "unauthenticated");
    return context;
  }
  const guard = (fn: () => Promise<Response>): Promise<Response> => fn().catch((error: unknown) => apiErrorResponse(error, "settings endpoint", clearSession));

  return {
    /** GET: every setting the shop may see, with its value, state and whether it asks for a PIN. */
    list: (request: Request) =>
      guard(async () => {
        const context = await requireSession(request);
        const views = await deps.db.rls(context, async (tx) => {
          await requirePermission(tx, "settings:view");
          return getSettings(tx);
        });
        return jsonResponse(200, { settings: views });
      }),

    /** POST { key, value, verificationId? }: save one setting. */
    save: (request: Request) =>
      guard(async () => {
        requireSameOrigin(request, deps.appUrl);
        const context = await requireSession(request);
        const body = await readJsonBody(request, saveBody);
        // the one value the database cannot judge: a language must be one this app offers
        if (body.key === "locale.default_language" && !isLocale(body.value)) throw new InvalidSettingError(body.key);
        await deps.db.rls(
          context,
          (tx) => saveSetting(tx, { key: body.key, value: body.value, ...(body.verificationId ? { verificationId: body.verificationId } : {}) }),
          { write: true },
        );
        return jsonResponse(200, { saved: true });
      }),
  };
}

export type SettingsHandlers = ReturnType<typeof createSettingsHandlers>;
