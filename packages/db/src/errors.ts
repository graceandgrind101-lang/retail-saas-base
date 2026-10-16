/**
 * Database errors the application needs to tell apart from "something broke".
 * Each has a fixed SQLSTATE, raised by the functions in migrations 0004 and 0006.
 */

/** The SQLSTATE of a Postgres error, whether raw or wrapped by Drizzle (which nests it in `cause`). */
export function pgErrorCode(error: unknown): string | undefined {
  const e = error as { code?: unknown; cause?: unknown } | null;
  if (e && typeof e.code === "string") return e.code;
  return e?.cause ? pgErrorCode(e.cause) : undefined;
}

/** The sign-in is over (ended, expired, staff suspended, shop closed). The person must sign in again. SQLSTATE 28000. */
export class SessionEndedError extends Error {
  constructor() {
    super("The session is no longer active. Sign in again.");
    this.name = "SessionEndedError";
  }
}

/** The invitation is unknown, used, expired, for a different email, or for a paused/closed shop. SQLSTATE RT001. */
export class InviteInvalidError extends Error {
  constructor() {
    super("This invitation is not valid.");
    this.name = "InviteInvalidError";
  }
}

/** The account is already a member of the shop that issued the invitation. SQLSTATE RT002. */
export class AlreadyMemberError extends Error {
  constructor() {
    super("This account is already a member of that shop.");
    this.name = "AlreadyMemberError";
  }
}

/** The account is not an active member of the shop it tried to enter. SQLSTATE RT003. */
export class NoShopAccessError extends Error {
  constructor() {
    super("This account has no access to that shop.");
    this.name = "NoShopAccessError";
  }
}

/** The PIN approval is unknown, used, expired, for another action or record, or asked for by someone else. SQLSTATE RT007. */
export class StepUpInvalidError extends Error {
  constructor() {
    super("This approval is not valid.");
    this.name = "StepUpInvalidError";
  }
}

/** The change would leave the shop without an owner. SQLSTATE RT008. */
export class LastOwnerError extends Error {
  constructor() {
    super("A shop must keep at least one owner.");
    this.name = "LastOwnerError";
  }
}

export const isSessionEndedError = (error: unknown): boolean => error instanceof SessionEndedError || pgErrorCode(error) === "28000";

/** Turn a raw database error into the matching application error; anything else is returned unchanged. */
export function translateAuthError(error: unknown): unknown {
  switch (pgErrorCode(error)) {
    case "28000":
      return new SessionEndedError();
    case "RT001":
      return new InviteInvalidError();
    case "RT002":
      return new AlreadyMemberError();
    case "RT003":
      return new NoShopAccessError();
    case "RT007":
      return new StepUpInvalidError();
    case "RT008":
      return new LastOwnerError();
    default:
      return error;
  }
}
