import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkDatabaseSecurity, formatViolations } from "../src/ci/security-check";
import { PG, adminSql, expectPgError } from "./helpers";
import { STANDARD_COLUMNS_SQL, createSecuredTable, dropTables } from "./probe-tables";

/**
 * The CI check must FAIL when a rule is broken. Each case below breaks exactly one rule in a
 * scratch table (or schema/role setting, restored afterwards) and expects the check to say so.
 */
let admin: Sql;

beforeAll(() => {
  admin = adminSql();
});
afterAll(async () => {
  await admin.end();
});

async function problemsFor(scope: string): Promise<string[]> {
  const all = await checkDatabaseSecurity(admin);
  return all.filter((v) => v.scope === scope).map((v) => v.problem);
}

/** Make `app.<name>` properly secured, run `break_`, return the problems found, then clean up. */
async function withBrokenTable(
  name: string,
  break_: (name: string) => Promise<void>,
  extra = "",
): Promise<string[]> {
  try {
    await createSecuredTable(admin, name, extra);
    expect(await problemsFor(`app.${name}`), "the table must start out clean").toEqual([]);
    await break_(name);
    return await problemsFor(`app.${name}`);
  } finally {
    await dropTables(admin, name);
  }
}

const has = (problems: string[], fragment: string) => problems.some((p) => p.includes(fragment));

describe("a correctly secured table", () => {
  it("passes", async () => {
    const problems = await withBrokenTable("chk_good", async () => undefined, "name text");
    expect(problems).toEqual([]);
  });
});

describe("the check catches a table that is not secured", () => {
  it("reports every missing protection when secure_tenant_table was never called", async () => {
    try {
      await admin.unsafe(`create table app.chk_unsecured (${STANDARD_COLUMNS_SQL}, unique (tenant_id, id))`);
      const problems = await problemsFor("app.chk_unsecured");
      expect(has(problems, "row-level security is not enabled")).toBe(true);
      expect(has(problems, "not FORCED")).toBe(true);
      expect(has(problems, "policy tenant_isolation is missing")).toBe(true);
      expect(has(problems, "touch_updated_at trigger")).toBe(true);
    } finally {
      await dropTables(admin, "chk_unsecured");
    }
  });
});

describe("the check catches one broken rule at a time", () => {
  it("row-level security switched off", async () => {
    const problems = await withBrokenTable("chk_rls_off", (n) => admin.unsafe(`alter table app.${n} disable row level security`).then(() => undefined));
    expect(has(problems, "row-level security is not enabled")).toBe(true);
  });

  it("row-level security not forced", async () => {
    const problems = await withBrokenTable("chk_no_force", (n) => admin.unsafe(`alter table app.${n} no force row level security`).then(() => undefined));
    expect(problems).toEqual(["row-level security is not FORCED"]);
  });

  it("a policy that lets everything through (USING true)", async () => {
    const problems = await withBrokenTable("chk_using_true", async (n) => {
      await admin.unsafe(`drop policy tenant_isolation on app.${n}`);
      await admin.unsafe(`create policy tenant_isolation on app.${n} for all to authenticated using (true) with check (true)`);
    });
    expect(has(problems, "USING is not tenant_id = ctx_tenant()")).toBe(true);
    expect(has(problems, "WITH CHECK is not tenant_id = ctx_tenant()")).toBe(true);
  });

  it("a policy that checks the wrong column", async () => {
    const problems = await withBrokenTable(
      "chk_wrong_col",
      async (n) => {
        await admin.unsafe(`drop policy tenant_isolation on app.${n}`);
        await admin.unsafe(
          `create policy tenant_isolation on app.${n} for all to authenticated using (created_by = (select private.ctx_tenant())) with check (created_by = (select private.ctx_tenant()))`,
        );
      },
    );
    expect(has(problems, "USING is not tenant_id = ctx_tenant()")).toBe(true);
  });

  it("a policy that only covers SELECT", async () => {
    const problems = await withBrokenTable("chk_select_only", async (n) => {
      await admin.unsafe(`drop policy tenant_isolation on app.${n}`);
      await admin.unsafe(
        `create policy tenant_isolation on app.${n} for select to authenticated using (tenant_id = (select private.ctx_tenant()))`,
      );
    });
    expect(has(problems, "does not cover ALL commands")).toBe(true);
  });

  it("a policy for the wrong role", async () => {
    const problems = await withBrokenTable("chk_wrong_role", async (n) => {
      await admin.unsafe(`drop policy tenant_isolation on app.${n}`);
      await admin.unsafe(
        `create policy tenant_isolation on app.${n} for all to anon using (tenant_id = (select private.ctx_tenant())) with check (tenant_id = (select private.ctx_tenant()))`,
      );
    });
    expect(has(problems, "expected authenticated")).toBe(true);
  });

  it("a second permissive policy that widens access", async () => {
    const problems = await withBrokenTable("chk_extra_policy", (n) =>
      admin.unsafe(`create policy let_everyone_read on app.${n} for select to authenticated using (true)`).then(() => undefined),
    );
    expect(has(problems, "unexpected policy let_everyone_read")).toBe(true);
  });

  it.each([
    ["anon", "select", "role anon has privileges"],
    ["service_role", "select", "role service_role has privileges"],
    ["retail_app", "select", "role retail_app has privileges"],
    ["public", "select", "PUBLIC has privileges"],
  ])("%s granted %s on the table", async (role, privilege, expected) => {
    const problems = await withBrokenTable(`chk_grant_${role}`, (n) =>
      admin.unsafe(`grant ${privilege} on app.${n} to ${role}`).then(() => undefined),
    );
    expect(has(problems, expected)).toBe(true);
  });

  it("authenticated granted TRUNCATE", async () => {
    const problems = await withBrokenTable("chk_truncate", (n) =>
      admin.unsafe(`grant truncate on app.${n} to authenticated`).then(() => undefined),
    );
    expect(has(problems, "authenticated has TRUNCATE")).toBe(true);
  });

  it("the touch_updated_at trigger disabled", async () => {
    const problems = await withBrokenTable("chk_trigger_off", (n) =>
      admin.unsafe(`alter table app.${n} disable trigger touch_updated_at`).then(() => undefined),
    );
    expect(has(problems, "touch_updated_at trigger is missing or disabled")).toBe(true);
  });
});

describe("the check catches structural mistakes in the table definition", () => {
  it("no tenant_id column (and secure_tenant_table refuses it)", async () => {
    try {
      await admin.unsafe("create table app.chk_no_tenant (id uuid primary key, name text)");
      await expectPgError(Promise.resolve(admin.unsafe("select private.secure_tenant_table('app.chk_no_tenant')")), "P0001");
      expect(has(await problemsFor("app.chk_no_tenant"), "no NOT NULL uuid tenant_id")).toBe(true);
    } finally {
      await dropTables(admin, "chk_no_tenant");
    }
  });

  it("a nullable tenant_id", async () => {
    try {
      await admin.unsafe("create table app.chk_nullable (id uuid primary key, tenant_id uuid references platform.tenants(id), unique (tenant_id, id))");
      await expectPgError(Promise.resolve(admin.unsafe("select private.secure_tenant_table('app.chk_nullable')")), "P0001");
      expect(has(await problemsFor("app.chk_nullable"), "no NOT NULL uuid tenant_id")).toBe(true);
    } finally {
      await dropTables(admin, "chk_nullable");
    }
  });

  it("no unique (tenant_id, id), so no composite foreign keys can target it", async () => {
    try {
      await admin.unsafe("create table app.chk_no_unique (id uuid primary key, tenant_id uuid not null references platform.tenants(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now())");
      await admin.unsafe("select private.secure_tenant_table('app.chk_no_unique')");
      expect(has(await problemsFor("app.chk_no_unique"), "no unique (tenant_id, id)")).toBe(true);
    } finally {
      await dropTables(admin, "chk_no_unique");
    }
  });

  it("tenant_id that is not a foreign key to platform.tenants", async () => {
    try {
      await admin.unsafe("create table app.chk_no_fk (id uuid primary key, tenant_id uuid not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique (tenant_id, id))");
      await admin.unsafe("select private.secure_tenant_table('app.chk_no_fk')");
      expect(has(await problemsFor("app.chk_no_fk"), "not a foreign key to platform.tenants")).toBe(true);
    } finally {
      await dropTables(admin, "chk_no_fk");
    }
  });

  it("secure_tenant_table refuses a table outside the app schema", async () => {
    await expectPgError(Promise.resolve(admin.unsafe("select private.secure_tenant_table('platform.tenants'::regclass)")), "P0001");
  });
});

describe("the check catches loosened schemas and roles (each restored afterwards)", () => {
  async function loosen(change: string, restore: string, scope: string): Promise<string[]> {
    try {
      await admin.unsafe(change);
      return await problemsFor(scope);
    } finally {
      await admin.unsafe(restore);
    }
  }

  it("platform schema opened to authenticated", async () => {
    const problems = await loosen("grant usage on schema platform to authenticated", "revoke usage on schema platform from authenticated", "schema platform");
    expect(has(problems, "role authenticated has USAGE")).toBe(true);
  });

  it("platform schema opened to PUBLIC", async () => {
    const problems = await loosen("grant usage on schema platform to public", "revoke usage on schema platform from public", "schema platform");
    expect(has(problems, "PUBLIC has USAGE")).toBe(true);
  });

  it("authenticated allowed to create objects in app", async () => {
    const problems = await loosen("grant create on schema app to authenticated", "revoke create on schema app from authenticated", "schema app");
    expect(has(problems, "role authenticated has CREATE")).toBe(true);
  });

  it("audit schema opened early to retail_app", async () => {
    const problems = await loosen("grant usage on schema audit to retail_app", "revoke usage on schema audit from retail_app", "schema audit");
    expect(has(problems, "role retail_app has USAGE")).toBe(true);
  });

  it("authenticated loses the usage it needs on app", async () => {
    const problems = await loosen("revoke usage on schema app from authenticated", "grant usage on schema app to authenticated", "schema app");
    expect(has(problems, "lost USAGE")).toBe(true);
  });

  it("a platform table made readable by authenticated", async () => {
    const problems = await loosen("grant select on platform.tenants to authenticated", "revoke select on platform.tenants from authenticated", "platform.tenants");
    expect(has(problems, "role authenticated has privileges")).toBe(true);
  });

  it("retail_app switched to INHERIT, so forgetting db.rls() would no longer fail loudly", async () => {
    const problems = await loosen("alter role retail_app inherit", "alter role retail_app noinherit", "role retail_app");
    expect(has(problems, "inherits privileges")).toBe(true);
  });

  it("returns to a clean bill of health after all that", async () => {
    expect(formatViolations(await checkDatabaseSecurity(admin))).toBe("");
  });
});

describe("the check catches a weakened audit log (each change restored afterwards)", () => {
  async function loosen(change: string, restore: string, scope: string): Promise<string[]> {
    try {
      await admin.unsafe(change);
      return await problemsFor(scope);
    } finally {
      await admin.unsafe(restore);
    }
  }

  it("a tenant table with no audit trigger", async () => {
    const problems = await withBrokenTable("chk_no_audit", (n) => admin.unsafe(`drop trigger audit_row on app.${n}`).then(() => undefined));
    expect(has(problems, "audit_row trigger is missing")).toBe(true);
  });

  it("a tenant table whose audit trigger skips deletes", async () => {
    const problems = await withBrokenTable("chk_audit_no_delete", async (n) => {
      await admin.unsafe(`drop trigger audit_row on app.${n}`);
      await admin.unsafe(`create trigger audit_row after insert or update on app.${n} for each row execute function audit.record_row_change()`);
    });
    expect(has(problems, "audit_row trigger is missing")).toBe(true);
  });

  it("a tenant table whose audit trigger is switched off", async () => {
    const problems = await withBrokenTable("chk_audit_off", (n) => admin.unsafe(`alter table app.${n} disable trigger audit_row`).then(() => undefined));
    expect(has(problems, "audit_row trigger is missing")).toBe(true);
  });

  it("a tenant table with no read-only enforcement for paused shops", async () => {
    const problems = await withBrokenTable("chk_no_writable", (n) => admin.unsafe(`drop trigger enforce_writable on app.${n}`).then(() => undefined));
    expect(has(problems, "enforce_writable trigger is missing")).toBe(true);
  });

  it("a tenant table whose read-only trigger is switched off", async () => {
    const problems = await withBrokenTable("chk_writable_off", (n) => admin.unsafe(`alter table app.${n} disable trigger enforce_writable`).then(() => undefined));
    expect(has(problems, "enforce_writable trigger is missing")).toBe(true);
  });

  it("a tenant table whose read-only trigger only covers inserts", async () => {
    const problems = await withBrokenTable("chk_writable_insert_only", async (n) => {
      await admin.unsafe(`drop trigger enforce_writable on app.${n}`);
      await admin.unsafe(`create trigger enforce_writable before insert on app.${n} for each statement execute function private.assert_tenant_writable()`);
    });
    expect(has(problems, "enforce_writable trigger is missing")).toBe(true);
  });

  it("authenticated allowed to INSERT into the audit log", async () => {
    const problems = await loosen("grant insert on audit.log to authenticated", "revoke insert on audit.log from authenticated", "audit.log");
    expect(has(problems, "authenticated has INSERT")).toBe(true);
  });

  it("authenticated allowed to read the anchors", async () => {
    const problems = await loosen("grant select on audit.anchors to authenticated", "revoke select on audit.anchors from authenticated", "audit.anchors");
    expect(has(problems, "authenticated has SELECT")).toBe(true);
  });

  it("anon allowed to read the audit log", async () => {
    const problems = await loosen("grant select on audit.log to anon", "revoke select on audit.log from anon", "audit.log");
    expect(has(problems, "role anon has privileges")).toBe(true);
  });

  it("the owner given back the right to edit the log", async () => {
    const problems = await loosen("grant update on audit.log to current_user", "revoke update on audit.log from current_user", "audit.log");
    expect(has(problems, "the owner still has UPDATE")).toBe(true);
  });

  it("the audit log's tenant policy replaced by one that lets everything through", async () => {
    const problems = await loosen(
      "drop policy tenant_read on audit.log; create policy tenant_read on audit.log for select to authenticated using (true)",
      "drop policy tenant_read on audit.log; create policy tenant_read on audit.log as permissive for select to authenticated using (tenant_id = (select private.ctx_tenant()))",
      "audit.log",
    );
    expect(has(problems, "tenant_read USING is not tenant_id = ctx_tenant()")).toBe(true);
  });

  it("a second policy added to the audit log", async () => {
    const problems = await loosen(
      "create policy read_all on audit.log for select to authenticated using (true)",
      "drop policy read_all on audit.log",
      "audit.log",
    );
    expect(has(problems, "expected exactly one policy")).toBe(true);
  });

  it("row-level security switched off on the audit log", async () => {
    const problems = await loosen("alter table audit.log disable row level security", "alter table audit.log enable row level security", "audit.log");
    expect(has(problems, "row-level security is not enabled")).toBe(true);
  });

  it.each(["audit_log_immutable_rows", "audit_log_immutable_truncate"])("the append-only trigger %s switched off", async (trigger) => {
    const problems = await loosen(`alter table audit.log disable trigger ${trigger}`, `alter table audit.log enable trigger ${trigger}`, "audit.log");
    expect(has(problems, "append-only trigger")).toBe(true);
  });

  it("an owner-only audit function opened to authenticated", async () => {
    const fn = "audit.record_event_for(uuid, text, jsonb)";
    const problems = await loosen(`grant execute on function ${fn} to authenticated`, `revoke execute on function ${fn} from authenticated`, "function audit.record_event_for");
    expect(has(problems, "owner-only audit function")).toBe(true);
  });

  it("an audit function opened to PUBLIC", async () => {
    const fn = "audit.append(uuid, text, text, uuid, jsonb, jsonb)";
    const problems = await loosen(`grant execute on function ${fn} to public`, `revoke execute on function ${fn} from public`, "function audit.append");
    expect(has(problems, "PUBLIC can execute")).toBe(true);
  });

  it("a function the shop needs that it can no longer call", async () => {
    const fn = "audit.record_event(text, jsonb)";
    const problems = await loosen(`revoke execute on function ${fn} from authenticated`, `grant execute on function ${fn} to authenticated`, "function audit.record_event");
    expect(has(problems, "lost access")).toBe(true);
  });

  it.each(["api_token", "secret_note", "password_hint", "pin_hash", "key_hash"])(
    "a secret-looking column (%s) that the audit log does not redact",
    async (column) => {
      try {
        await createSecuredTable(admin, "chk_secret_col", `${column} text`);
        expect(has(await problemsFor("app.chk_secret_col"), `column ${column} is not redacted`)).toBe(true);
      } finally {
        await dropTables(admin, "chk_secret_col");
      }
    },
  );

  it("the same column is fine once it is redacted", async () => {
    try {
      await createSecuredTable(admin, "chk_secret_ok", "api_token text", { redact: ["api_token"] });
      expect(await problemsFor("app.chk_secret_ok")).toEqual([]);
    } finally {
      await dropTables(admin, "chk_secret_ok");
    }
  });

  it("the staff table losing its redactions (a careless re-run of secure_tenant_table with defaults)", async () => {
    try {
      await admin.unsafe("select private.secure_tenant_table('app.staff', array['pin_failed_count']::text[], array[]::text[])");
      const problems = await problemsFor("app.staff");
      for (const column of ["pin_hash", "invite_token_hash", "phone", "invite_email"]) {
        expect(has(problems, `column ${column} is not redacted`), column).toBe(true);
      }
    } finally {
      await admin.unsafe(
        "select private.secure_tenant_table('app.staff', array['pin_failed_count']::text[], array['pin_hash', 'invite_token_hash', 'phone', 'invite_email']::text[])",
      );
    }
    expect(await problemsFor("app.staff")).toEqual([]);
  });

  it("a SECURITY DEFINER function with no fixed search_path", async () => {
    try {
      await admin.unsafe("create function private.zz_unsafe() returns int language sql security definer as 'select 1'");
      const problems = await problemsFor("function private.zz_unsafe");
      expect(has(problems, "SECURITY DEFINER without a fixed search_path")).toBe(true);
    } finally {
      await admin.unsafe("drop function if exists private.zz_unsafe()");
    }
  });
});

describe("the policy error SQLSTATE used above", () => {
  it("is what a tenant sees when an insert is blocked", () => {
    expect(PG.permissionDenied).toBe("42501");
  });
});
