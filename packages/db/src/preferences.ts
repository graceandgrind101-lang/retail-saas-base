import { sql } from "drizzle-orm";
import type { RlsTransaction } from "./rls";

/**
 * The signed-in person's own display choices (language and calendar). Only their own row is
 * touched, found from the verified session, never from anything the caller sends. The caller
 * checks that the language is one the app offers; the database checks the calendar.
 * Pass only what changes. Run with `write: true`.
 */
export async function setMyPreferences(tx: RlsTransaction, input: { language?: string; calendar?: "gregorian" | "ethiopian" }): Promise<void> {
  if (input.language !== undefined) {
    await tx.execute(sql`update app.staff set preferred_language = ${input.language} where id = private.ctx_staff()`);
  }
  if (input.calendar !== undefined) {
    await tx.execute(sql`update app.staff set preferred_calendar = ${input.calendar} where id = private.ctx_staff()`);
  }
}
