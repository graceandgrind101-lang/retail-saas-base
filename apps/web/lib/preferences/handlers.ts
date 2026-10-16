import { z } from "zod";
import { CALENDARS, isLocale } from "@retail/i18n";
import { SessionEndedError, setMyPreferences, type TenantDb } from "@retail/db";
import { clearedSessionCookieHeader } from "../auth/cookie";
import { apiErrorResponse, readJsonBody, readSessionContext, requireSameOrigin } from "../http";
import { calendarCookieHeader, languageCookieHeader } from "./cookies";

/**
 * POST { language?, calendar? } (Phase A task A11): remember the language and calendar. They are
 * always kept in cookies (so the sign-in screen can follow them) and, when someone is signed in,
 * saved on their own staff record so they follow the person to another device.
 */

export interface PreferenceDeps {
  db: TenantDb;
  sessionSecret: string;
  appUrl: string;
  now?: () => number;
}

const body = z
  .object({
    language: z.string().refine(isLocale, "not an offered language").optional(),
    calendar: z.enum(CALENDARS as [string, ...string[]]).optional(),
  })
  .strict()
  .refine((value) => value.language !== undefined || value.calendar !== undefined, "nothing to change");

export function createPreferenceHandlers(deps: PreferenceDeps) {
  const now = deps.now ?? Date.now;
  const clearSession = { "set-cookie": clearedSessionCookieHeader(deps.appUrl) };

  return {
    set: async (request: Request): Promise<Response> => {
      try {
        requireSameOrigin(request, deps.appUrl);
        const choice = await readJsonBody(request, body);
        let saved = false;
        const context = await readSessionContext(request, { appUrl: deps.appUrl, sessionSecret: deps.sessionSecret, nowSeconds: Math.floor(now() / 1000) });
        if (context) {
          try {
            await deps.db.rls(context, (tx) => setMyPreferences(tx, { ...(choice.language ? { language: choice.language } : {}), ...(choice.calendar ? { calendar: choice.calendar as "gregorian" | "ethiopian" } : {}) }), { write: true });
            saved = true;
          } catch (error) {
            // A sign-in that has ended just means the choice is not saved on a person; the browser still remembers it.
            if (!(error instanceof SessionEndedError)) throw error;
          }
        }
        const response = new Response(JSON.stringify({ language: choice.language ?? null, calendar: choice.calendar ?? null, saved }), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        });
        if (choice.language) response.headers.append("set-cookie", languageCookieHeader(deps.appUrl, choice.language));
        if (choice.calendar) response.headers.append("set-cookie", calendarCookieHeader(deps.appUrl, choice.calendar));
        return response;
      } catch (error) {
        return apiErrorResponse(error, "preferences endpoint", clearSession);
      }
    },
  };
}

export type PreferenceHandlers = ReturnType<typeof createPreferenceHandlers>;
