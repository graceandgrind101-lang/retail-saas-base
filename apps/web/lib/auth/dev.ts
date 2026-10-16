import { z } from "zod";
import { DEV_DEMO_OWNER_ACCOUNT_ID, devSignInEnabled, signSessionCookie } from "@retail/core";
import { listMyShops, startSession, type TenantDb } from "@retail/db";
import { clearedSessionCookieHeader, sessionCookieHeader } from "./cookie";
import { HttpError, apiErrorResponse, jsonResponse, readJsonBody, requireSameOrigin } from "../http";

/**
 * Developer sign-in (see core: dev-sign-in.ts): enter as the demo shop's owner on your own computer.
 * It answers "not found" unless ALLOW_DEV_SIGN_IN=1 in a non-production build, and it only ever
 * signs in the one fixed demo account, never a account the caller names.
 */
export interface DevSignInDeps {
  db: TenantDb;
  sessionSecret: string;
  appUrl: string;
  /** The environment to read the switch from (process.env). */
  env: Readonly<Record<string, string | undefined>>;
  now?: () => number;
}

const body = z.object({}).strict();

export function createDevSignIn(deps: DevSignInDeps) {
  const now = deps.now ?? Date.now;
  return async (request: Request): Promise<Response> => {
    try {
      if (!devSignInEnabled(deps.env)) throw new HttpError(404, "not_found");
      requireSameOrigin(request, deps.appUrl);
      await readJsonBody(request, body);
      const identity = { authUserId: DEV_DEMO_OWNER_ACCOUNT_ID, email: "dev@example.com" };
      const shops = await deps.db.identity(identity, (tx) => listMyShops(tx));
      const shop = shops[0];
      if (!shop) throw new HttpError(404, "no_demo_shop"); // run `pnpm dev:seed`
      const started = await deps.db.identity(identity, (tx) => startSession(tx, { tenantId: shop.tenantId, method: "password" }));
      const expiresAtSeconds = Math.floor(started.expiresAt.getTime() / 1000);
      const cookie = await signSessionCookie(
        { tenantId: started.tenantId, staffId: started.staffId, sessionId: started.sessionId, expiresAt: expiresAtSeconds },
        deps.sessionSecret,
      );
      return jsonResponse(200, { signedIn: true }, { "set-cookie": sessionCookieHeader(deps.appUrl, cookie, expiresAtSeconds - now() / 1000) });
    } catch (error) {
      return apiErrorResponse(error, "dev sign-in", { "set-cookie": clearedSessionCookieHeader(deps.appUrl) });
    }
  };
}
