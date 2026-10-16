import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RESERVED_TENANT_SLUGS, isValidTenantSlug } from "@retail/core";
import { PG, adminSql, expectPgError, newId } from "./helpers";

let admin: Sql;

beforeAll(() => {
  admin = adminSql();
});
afterAll(async () => {
  await admin.end();
});

const insert = (slug: string, displayName: unknown = { en: "Shop" }) =>
  Promise.resolve(
    admin`insert into platform.tenants (id, slug, display_name, industry, plan_key)
          values (${newId()}, ${slug}, ${admin.json(displayName as never)}, 'electronics', 'pro')`,
  );

describe("platform.tenants", () => {
  it("fills in sensible defaults", async () => {
    const id = newId();
    await admin`insert into platform.tenants (id, slug, display_name, industry, plan_key)
                values (${id}, ${`dflt-${id.slice(-8)}`}, ${admin.json({ en: "Shop" })}, 'minimarket', 'pro')`;
    const [row] = await admin<{ status: string; timezone: string; currency: string; created_at: Date; paused_at: Date | null }[]>`
      select status, timezone, currency, created_at, paused_at from platform.tenants where id = ${id}`;
    expect(row?.status).toBe("pilot");
    expect(row?.timezone).toBe("Africa/Addis_Ababa");
    expect(row?.currency).toBe("ETB");
    expect(row?.created_at).toBeInstanceOf(Date);
    expect(row?.paused_at).toBeNull();
  });

  it.each(["abc", "x".repeat(40), "shop-24", "a1b"])("accepts the slug %j", async (slug) => {
    // the test database is brand new on every run, so these literals cannot collide
    await expect(insert(slug)).resolves.toBeDefined();
  });

  it.each(["ab", "x".repeat(41), "-shop", "shop-", "Shop", "my_shop", "my shop", "shop.example", ""])(
    "rejects the slug %j",
    async (slug) => {
      await expectPgError(insert(slug), PG.checkViolation);
    },
  );

  it("rejects every subdomain we use ourselves", async () => {
    for (const reserved of RESERVED_TENANT_SLUGS) {
      await expectPgError(insert(reserved), PG.checkViolation);
    }
  });

  it("rejects a duplicate slug", async () => {
    const slug = `dup-${newId().slice(-8)}`;
    await insert(slug);
    await expectPgError(insert(slug), PG.uniqueViolation);
  });

  it.each([
    ["an empty object", {}],
    ["a plain string", "just text"],
    ["an array", ["x"]],
  ])("rejects a display name that is %s", async (_label, value) => {
    await expectPgError(insert(`name-${newId().slice(-10)}`, value), PG.checkViolation);
  });

  it("rejects a missing display name (SQL NULL) and a JSON null", async () => {
    const slug = (n: string) => `${n}-${newId().slice(-8)}`;
    await expectPgError(
      Promise.resolve(admin`insert into platform.tenants (id, slug, display_name, industry, plan_key)
                            values (${newId()}, ${slug("sqlnull")}, null, 'other', 'pro')`),
      PG.notNullViolation,
    );
    await expectPgError(
      Promise.resolve(admin`insert into platform.tenants (id, slug, display_name, industry, plan_key)
                            values (${newId()}, ${slug("jsonnull")}, 'null'::jsonb, 'other', 'pro')`),
      PG.checkViolation,
    );
  });

  it("accepts a name in Amharic only", async () => {
    await expect(insert(`am-${newId().slice(-10)}`, { am: "ንጋቱ ሞባይል" })).resolves.toBeDefined();
  });

  it("agrees with @retail/core about which slugs are valid", async () => {
    const samples = ["abc", "ab", "app", "Console", "nati-mobile", "-x-", "x-y-z", "shop24", "UPPER", "a_b", "status", "ok-shop"];
    for (const slug of samples) {
      let accepted = true;
      try {
        // valid slugs get a unique suffix so a duplicate can never hide a mismatch
        await insert(isValidTenantSlug(slug) ? uniqueSlug(slug) : slug);
      } catch {
        accepted = false;
      }
      expect(accepted, `slug ${JSON.stringify(slug)}`).toBe(isValidTenantSlug(slug));
    }
  });
});

function uniqueSlug(base: string): string {
  const suffix = newId().slice(-6);
  return `${base.slice(0, 33)}-${suffix}`;
}
