import { readFileSync } from "node:fs";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inject } from "vitest";
import { checkDatabaseSecurity, formatViolations } from "../src/ci/security-check";
import { runMigrations } from "../src/migrate";
import { RLS_SETTINGS, createTenantDb } from "../src/rls";
import { PG, adminSql, appSql, appUrl, createStaffSession, createTenant, expectPgError, newId } from "./helpers";

let admin: Sql;
let app: Sql;

beforeAll(() => {
  admin = adminSql();
  app = appSql();
});
afterAll(async () => {
  await Promise.all([admin.end(), app.end()]);
});

describe("migrations", () => {
  it("record every migration in the journal and are safe to run again", async () => {
    await runMigrations(inject("adminUrl"));
    const journal = JSON.parse(readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as {
      entries: unknown[];
    };
    const [row] = await admin<{ n: number }[]>`select count(*)::int as n from drizzle.__drizzle_migrations`;
    expect(journal.entries.length).toBeGreaterThanOrEqual(3);
    expect(row?.n).toBe(journal.entries.length);
  });

  it("leave a database that passes the security check", async () => {
    const violations = await checkDatabaseSecurity(admin);
    expect(formatViolations(violations)).toBe("");
  });
});

describe("roles", () => {
  it("retail_app cannot bypass RLS, is not a superuser and does not inherit", async () => {
    const [role] = await admin<{ rolsuper: boolean; rolbypassrls: boolean; rolinherit: boolean; rolcanlogin: boolean }[]>`
      select rolsuper, rolbypassrls, rolinherit, rolcanlogin from pg_roles where rolname = 'retail_app'`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false, rolinherit: false, rolcanlogin: true });
  });

  it("a real login as retail_app works", async () => {
    const [row] = await app<{ who: string }[]>`select current_user as who`;
    expect(row?.who).toBe("retail_app");
  });

  it("retail_app can switch to authenticated and nothing else useful", async () => {
    const result = await app.begin(async (tx) => {
      await tx`set local role authenticated`;
      return tx<{ who: string }[]>`select current_user as who`;
    });
    expect(result[0]?.who).toBe("authenticated");
  });
});

describe("schema lockdown", () => {
  it("platform is invisible to retail_app, even after switching to authenticated", async () => {
    await expectPgError(Promise.resolve(app`select * from platform.tenants`), PG.permissionDenied);
    await expectPgError(
      Promise.resolve(
        app.begin(async (tx) => {
          await tx`set local role authenticated`;
          return tx`select * from platform.tenants`;
        }),
      ),
      PG.permissionDenied,
    );
  });

  it("platform cannot be written either", async () => {
    await expectPgError(
      Promise.resolve(
        app.begin(async (tx) => {
          await tx`set local role authenticated`;
          return tx`insert into platform.tenants (id, slug, display_name, industry, plan_key)
                    values (${newId()}, 'sneaky', '{"en":"x"}', 'other', 'pro')`;
        }),
      ),
      PG.permissionDenied,
    );
  });

  it("authenticated cannot create objects in app or private", async () => {
    for (const schema of ["app", "private"]) {
      await expectPgError(
        Promise.resolve(
          app.begin(async (tx) => {
            await tx`set local role authenticated`;
            return tx.unsafe(`create table ${schema}.zz_made_by_tenant (id int)`);
          }),
        ),
        PG.permissionDenied,
      );
    }
  });

  it("authenticated cannot call private.secure_tenant_table", async () => {
    await expectPgError(
      Promise.resolve(
        app.begin(async (tx) => {
          await tx`set local role authenticated`;
          return tx`select private.secure_tenant_table('platform.tenants'::regclass)`;
        }),
      ),
      PG.permissionDenied,
    );
  });
});

describe("request context functions", () => {
  const idA = newId();

  async function read(setting: string | null, fn = "private.ctx_tenant") {
    return admin.begin(async (tx) => {
      if (setting !== null) await tx`select set_config('app.tenant_id', ${setting}, true)`;
      const [row] = await tx.unsafe<{ v: string | null }[]>(`select ${fn}()::text as v`);
      return row?.v ?? null;
    });
  }

  it("return the id that was set", async () => {
    expect(await read(idA)).toBe(idA);
  });

  it("return NULL when nothing is set, so every policy is false", async () => {
    expect(await read(null)).toBeNull();
  });

  it.each([
    ["empty string", ""],
    ["not a uuid", "tenant-1"],
    ["sql fragment", "x' or '1'='1"],
    ["nil uuid", "00000000-0000-0000-0000-000000000000"],
    ["trailing junk", `${idA} `],
    ["wrong version", "550e8400-e29b-91d4-a716-446655440000"],
  ])("return NULL for a malformed value (%s)", async (_label, value) => {
    expect(await read(value)).toBeNull();
  });

  it("each ctx_* function reads its own setting", async () => {
    const tenant = await createTenant(admin, `ctx-${newId().slice(-10)}`);
    const real = await createStaffSession(admin, tenant);
    const ids = {
      ...(Object.fromEntries(Object.keys(RLS_SETTINGS).map((k) => [k, newId()])) as Record<keyof typeof RLS_SETTINGS, string>),
      tenantId: tenant,
      staffId: real.staffId,
      sessionId: real.sessionId,
    };
    const fns: Record<keyof typeof RLS_SETTINGS, string> = {
      tenantId: "private.ctx_tenant",
      staffId: "private.ctx_staff",
      sessionId: "private.ctx_session",
      deviceId: "private.ctx_device",
      impersonatorId: "private.ctx_impersonator",
      pinVerificationId: "private.ctx_pin_verification",
    };
    const db = createTenantDb(appUrl(), { max: 1 });
    try {
      const seen = await db.rls(ids, async (tx) => {
        const rows = await tx.execute<Record<string, string>>(
          // dynamic function list built from constants above, never from input
          (await import("drizzle-orm")).sql.raw(
            `select ${Object.entries(fns).map(([k, f]) => `${f}()::text as "${k}"`).join(", ")}`,
          ),
        );
        return rows[0];
      });
      expect(seen).toEqual(ids);
    } finally {
      await db.close();
    }
  });
});
