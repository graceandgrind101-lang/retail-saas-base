import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { InvalidRlsContextError, RLS_SETTINGS, createTenantDb, runWithRls, type RlsContext, type TenantDb } from "../src/rls";
import * as schema from "../src/schema";
import { adminSql, appUrl, createStaffSession, createTenant, newId } from "./helpers";
import { createSecuredTable, dropTables } from "./probe-tables";

let admin: Sql;
let db: TenantDb;
let tenant = "";

beforeAll(async () => {
  admin = adminSql();
  db = createTenantDb(appUrl(), { max: 1 });
  tenant = await createTenant(admin, `wrap-${randomBytes(4).toString("hex")}`);
  await createSecuredTable(admin, "wrap_probe", "label text not null");
});
afterAll(async () => {
  await dropTables(admin, "wrap_probe");
  await db.close();
  await admin.end();
});

const rowCount = async (label: string) => {
  const [row] = await admin<{ n: number }[]>`select count(*)::int as n from app.wrap_probe where label = ${label}`;
  return row?.n ?? 0;
};

describe("the public surface", () => {
  it("offers only rls(), identity() and close(): there is no way to run an unscoped query", () => {
    expect(Object.keys(db).sort()).toEqual(["close", "identity", "rls"]);
  });
});

describe("context validation happens before the database is touched", () => {
  const good = newId();

  it.each([
    ["tenantId: not a uuid", { tenantId: "tenant-1" }, "tenantId"],
    ["tenantId: empty", { tenantId: "" }, "tenantId"],
    ["tenantId: sql fragment", { tenantId: `${good}'; drop table x; --` }, "tenantId"],
    ["tenantId: surrounding space", { tenantId: ` ${good}` }, "tenantId"],
    ["staffId: bad", { tenantId: good, staffId: "nope" }, "staffId"],
    ["sessionId: bad", { tenantId: good, sessionId: "nope" }, "sessionId"],
    ["deviceId: bad", { tenantId: good, deviceId: "nope" }, "deviceId"],
    ["impersonatorId: bad", { tenantId: good, impersonatorId: "nope" }, "impersonatorId"],
    ["pinVerificationId: bad", { tenantId: good, pinVerificationId: "nope" }, "pinVerificationId"],
  ])("rejects %s", async (_label, ctx, field) => {
    const fn = vi.fn(async () => "ran");
    await expect(db.rls(ctx, fn)).rejects.toThrow(InvalidRlsContextError);
    await expect(db.rls(ctx, fn)).rejects.toThrow(field);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("identity never outlives its transaction", () => {
  it("leaves none of the six settings behind on a reused connection", async () => {
    // One connection, used first by the wrapper and then directly, so a leak would show.
    const client = postgres(appUrl(), { max: 1, onnotice: () => {} });
    try {
      const drizzleOnSameConnection = drizzle(client, { schema });
      // the staff and session ids must be real: a claimed session is verified against the database
      const real = await createStaffSession(admin, tenant);
      const everything = {
        ...(Object.fromEntries(Object.keys(RLS_SETTINGS).map((k) => [k, newId()])) as unknown as RlsContext),
        tenantId: tenant,
        staffId: real.staffId,
        sessionId: real.sessionId,
      };
      await runWithRls(drizzleOnSameConnection, everything, async () => undefined);

      const left = await client.begin(async (tx) => {
        await tx`set local role authenticated`;
        const [row] = await tx<Record<string, string | null>[]>`
          select private.ctx_tenant()::text as tenant, private.ctx_staff()::text as staff,
                 private.ctx_session()::text as session, private.ctx_device()::text as device,
                 private.ctx_impersonator()::text as impersonator, private.ctx_pin_verification()::text as pin`;
        return row;
      });
      expect(left).toEqual({ tenant: null, staff: null, session: null, device: null, impersonator: null, pin: null });
    } finally {
      await client.end();
    }
  });

  it("leaves none behind after a failed request either", async () => {
    const client = postgres(appUrl(), { max: 1, onnotice: () => {} });
    try {
      const drizzleOnSameConnection = drizzle(client, { schema });
      const real = await createStaffSession(admin, tenant);
      await expect(
        runWithRls(drizzleOnSameConnection, { tenantId: tenant, staffId: real.staffId, sessionId: real.sessionId }, async () => {
          throw new Error("request failed");
        }),
      ).rejects.toThrow("request failed");
      const [row] = await client.begin(async (tx) => {
        await tx`set local role authenticated`;
        return tx<{ tenant: string | null }[]>`select private.ctx_tenant()::text as tenant`;
      });
      expect(row?.tenant).toBeNull();
    } finally {
      await client.end();
    }
  });
});

describe("transactions", () => {
  it("commits what the callback wrote and returns its result", async () => {
    const label = `commit-${newId()}`;
    const result = await db.rls({ tenantId: tenant }, async (tx) => {
      await tx.execute(sql`insert into app.wrap_probe (id, tenant_id, label) values (${newId()}, ${tenant}, ${label})`);
      return "done";
    });
    expect(result).toBe("done");
    expect(await rowCount(label)).toBe(1);
  });

  it("rolls everything back if the callback throws", async () => {
    const label = `rollback-${newId()}`;
    await expect(
      db.rls({ tenantId: tenant }, async (tx) => {
        await tx.execute(sql`insert into app.wrap_probe (id, tenant_id, label) values (${newId()}, ${tenant}, ${label})`);
        await tx.execute(sql`insert into app.wrap_probe (id, tenant_id, label) values (${newId()}, ${tenant}, ${label})`);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await rowCount(label)).toBe(0);
  });

  it("runs the callback as the authenticated role, not as the login role", async () => {
    const who = await db.rls({ tenantId: tenant }, async (tx) => {
      const rows = await tx.execute<{ u: string }>(sql`select current_user as u`);
      return rows[0]?.u;
    });
    expect(who).toBe("authenticated");
  });

  it("optional fields default to empty, which every ctx function reads as NULL", async () => {
    const seen = await db.rls({ tenantId: tenant }, async (tx) => {
      const rows = await tx.execute<{ staff: string | null; device: string | null }>(
        sql`select private.ctx_staff()::text as staff, private.ctx_device()::text as device`,
      );
      return rows[0];
    });
    expect(seen).toEqual({ staff: null, device: null });
  });
});
