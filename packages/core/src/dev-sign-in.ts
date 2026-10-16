/**
 * Developer sign-in (Phase A task A13): a way to enter the app as the demo shop's owner on your
 * own computer, before any real account system is connected. It exists ONLY for development:
 *
 *  - it works only while `ALLOW_DEV_SIGN_IN=1` AND the app is not a production build;
 *  - a production build that finds `ALLOW_DEV_SIGN_IN` set at all refuses to start (see parseServerEnv),
 *    so a forgotten setting can never open a door on a live server.
 */

/** The demo owner's account id: a fixed value that `pnpm dev:seed` gives the demo shop's owner. */
export const DEV_DEMO_OWNER_ACCOUNT_ID = "00000000-0000-4000-8000-00000000d0a1";

type Source = Readonly<Record<string, string | undefined>>;

export function devSignInEnabled(source: Source): boolean {
  return source.ALLOW_DEV_SIGN_IN === "1" && source.NODE_ENV !== "production";
}

/** A message when the setting is dangerous (present in a production build), else null. */
export function devSignInProblem(source: Source): string | null {
  if (source.NODE_ENV === "production" && source.ALLOW_DEV_SIGN_IN !== undefined && source.ALLOW_DEV_SIGN_IN !== "") {
    return "ALLOW_DEV_SIGN_IN: must not be set in a production build (the developer sign-in is for local development only)";
  }
  return null;
}
