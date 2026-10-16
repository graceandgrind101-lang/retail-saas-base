import postgres, { type Sql } from "postgres";
import { inject } from "vitest";
import { expect } from "vitest";
import { uuidv7 } from "@retail/core";

export const newId = (): string => uuidv7();

/** Owner connection: bypasses row-level security. For setup and for checking the truth. */
export function adminSql(max = 2): Sql {
  return postgres(inject("adminUrl"), { max, onnotice: () => {} });
}

/** A real login as `retail_app`, the same role the shop app uses. */
export function appSql(max = 1): Sql {
  return postgres(inject("appUrl"), { max, onnotice: () => {} });
}

export function appUrl(): string {
  return inject("appUrl");
}

/** Insert a tenant straight into platform.tenants (admin only) and return its id. */
export async function createTenant(admin: Sql, slug: string): Promise<string> {
  const id = newId();
  await admin`
    insert into platform.tenants (id, slug, display_name, industry, plan_key)
    values (${id}, ${slug}, ${admin.json({ en: slug })}, 'electronics', 'pro')`;
  return id;
}

/** The SQLSTATE of a Postgres error, whether raw or wrapped by Drizzle. */
export function pgCode(error: unknown): string | undefined {
  const e = error as { code?: unknown; cause?: unknown } | null;
  if (e && typeof e.code === "string") return e.code;
  if (e?.cause) return pgCode(e.cause);
  return undefined;
}

/** Assert a promise rejects with a Postgres error carrying this SQLSTATE. */
export async function expectPgError(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected a Postgres error ${code}, but the statement succeeded`).toBeDefined();
  expect(pgCode(caught), `wrong error: ${String((caught as Error)?.message)}`).toBe(code);
}

export const PG = {
  permissionDenied: "42501", // also: row violates row-level security policy
  foreignKeyViolation: "23503",
  uniqueViolation: "23505",
  checkViolation: "23514",
  notNullViolation: "23502",
} as const;
