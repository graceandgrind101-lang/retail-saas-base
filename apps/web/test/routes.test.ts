import { randomBytes } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { createAdminDb, provisionTenant, type AdminDb } from "@retail/db/admin";
import { resetAuthHandlers } from "../lib/auth/default";
import { resetServerEnvCache } from "../lib/env";
import { POST as acceptInvite } from "../app/api/auth/invite/accept/route";
import { GET as me } from "../app/api/auth/me/route";
import { POST as startSession } from "../app/api/auth/session/route";
import { POST as shops } from "../app/api/auth/shops/route";
import { POST as signOut } from "../app/api/auth/signout/route";
import { newUuid } from "./ids";
import { TEST_JWT_SECRET, TEST_SUPABASE_URL, mintToken } from "./tokens";

const APP_URL = "http://localhost:3000";

/** The real route files, wired the way the running app wires them: from the environment only. */
function stubEnvironment(overrides: Record<string, string | undefined> = {}) {
  const env: Record<string, string | undefined> = {
    NEXT_PUBLIC_SUPABASE_URL: TEST_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-0123456789-abcdefghij",
    NEXT_PUBLIC_APP_URL: APP_URL,
    DATABASE_URL: inject("appUrl"),
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key-0123456789-ABCDEFGHIJ",
    SESSION_SECRET: "k3Jf9aQ2xLm7ZpR1tVb8nWc4yHd6sGu0",
    PIN_PEPPER: "Qw8eRt5yUi2oPa7sDf4gHj1kLz9xCv3b",
    DEVICE_TOKEN_PEPPER: "Zx6cVb3nMq8wEr1tYu4iOp7aSd2fGh5j",
    REFERENCE_PEPPER: "Lk9jHg6fDs3aPo0iUy7tRe4wQz1xCv8n",
    SUPABASE_JWT_SECRET: TEST_JWT_SECRET,
    ...overrides,
  };
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  resetServerEnvCache();
  resetAuthHandlers();
}

let admin: AdminDb;
beforeAll(() => {
  admin = createAdminDb(inject("adminUrl"), { max: 2 });
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetServerEnvCache();
  resetAuthHandlers();
});
afterAll(async () => {
  const holder = globalThis as unknown as { __retailTenantDb?: { close(): Promise<void> } };
  await holder.__retailTenantDb?.close();
  delete holder.__retailTenantDb;
  await admin.close();
});

const post = (path: string, init: { token?: string; body?: unknown; cookie?: string; origin?: string }) =>
  new Request(`${APP_URL}${path}`, {
    method: "POST",
    headers: {
      origin: init.origin ?? APP_URL,
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
    body: JSON.stringify(init.body ?? {}),
  });

describe("the real route files, wired from the environment", () => {
  it("run the whole journey: invitation, shops, sign in, who am I, sign out", async () => {
    stubEnvironment();
    const email = `route-${randomBytes(4).toString("hex")}@example.com`;
    const shop = await provisionTenant(admin.sql, {
      slug: `route-${randomBytes(4).toString("hex")}`,
      displayName: { en: "Route Shop" },
      industry: "other",
      planKey: "pro",
      owner: { email, displayName: "Route Owner" },
    });
    const token = await mintToken({ sub: newUuid(), email, provider: "google" });

    expect((await acceptInvite(post("/api/auth/invite/accept", { token, body: { token: shop.ownerInvite?.token } }))).status).toBe(200);
    const list = (await (await shops(post("/api/auth/shops", { token }))).json()) as { shops: { slug: string }[] };
    expect(list.shops.map((s) => s.slug)).toEqual([shop.slug]);

    const started = await startSession(post("/api/auth/session", { token, body: { tenantId: shop.tenantId } }));
    expect(started.status).toBe(200);
    const cookie = (started.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const who = await me(new Request(`${APP_URL}/api/auth/me`, { headers: { cookie } }));
    expect(who.status).toBe(200);
    expect(((await who.json()) as { tenant: { slug: string } }).tenant.slug).toBe(shop.slug);

    expect((await signOut(post("/api/auth/signout", { cookie }))).status).toBe(200);
    expect((await me(new Request(`${APP_URL}/api/auth/me`, { headers: { cookie } }))).status).toBe(401);
  });

  it("refuse a token signed for some other project, using the issuer derived from the environment", async () => {
    stubEnvironment();
    const email = `route-${randomBytes(4).toString("hex")}@example.com`;
    const token = await mintToken({ sub: newUuid(), email, issuer: "https://someone-else.supabase.co/auth/v1" });
    const response = await shops(post("/api/auth/shops", { token }));
    expect(response.status).toBe(401);
  });

  it("use the origin from the environment for the same-origin check", async () => {
    stubEnvironment({ NEXT_PUBLIC_APP_URL: "http://localhost:4000" });
    const token = await mintToken({ sub: newUuid(), email: "someone@example.com" });
    const wrong = await shops(post("/api/auth/shops", { token, origin: APP_URL }));
    expect(wrong.status).toBe(403);
    const right = await shops(post("/api/auth/shops", { token, origin: "http://localhost:4000" }));
    expect(right.status).toBe(200);
  });

  it("fail closed with a clear error if the environment is incomplete (a route never half-works)", async () => {
    stubEnvironment({ SESSION_SECRET: undefined });
    await expect(shops(post("/api/auth/shops", {}))).rejects.toThrow(/SESSION_SECRET/);
  });
});

describe("route files export only what Next allows", () => {
  // A route file may export HTTP method handlers and a few config fields; anything else is a build error
  // in Next, so logic belongs in lib/. Checked on every route file under app/api.
  const ALLOWED = new Set(["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "dynamic", "revalidate", "runtime", "maxDuration", "preferredRegion", "dynamicParams", "fetchCache"]);

  function routeFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return routeFiles(full);
      return name === "route.ts" ? [full] : [];
    });
  }

  const apiDir = join(__dirname, "..", "app", "api");
  const files = routeFiles(apiDir);

  it("finds every API route (add new ones here on purpose)", () => {
    expect(files.map((f) => relative(apiDir, f).replaceAll("\\", "/")).sort()).toEqual([
      "alerts/route.ts",
      "alerts/status/route.ts",
      "auth/invite/accept/route.ts",
      "auth/me/route.ts",
      "auth/session/route.ts",
      "auth/shops/route.ts",
      "auth/signout/route.ts",
      "dev/sign-in/route.ts",
      "devices/me/route.ts",
      "devices/pair/route.ts",
      "devices/pairing-codes/route.ts",
      "devices/pin-sign-in/route.ts",
      "devices/revoke/route.ts",
      "devices/unlock/route.ts",
      "preferences/route.ts",
      "roles/permissions/route.ts",
      "settings/route.ts",
      "staff/overrides/remove/route.ts",
      "staff/overrides/route.ts",
      "staff/pin/route.ts",
      "staff/role/route.ts",
      "staff/route.ts",
      "step-up/route.ts",
    ]);
  });

  it.each(files.map((f) => [relative(apiDir, f).replaceAll("\\", "/"), f]))("%s", async (_name, file) => {
    const routeModule = (await import(/* @vite-ignore */ file)) as Record<string, unknown>;
    const extra = Object.keys(routeModule).filter((key) => !ALLOWED.has(key));
    expect(extra, `route files may only export HTTP handlers; move this to lib/: ${extra.join(", ")}`).toEqual([]);
    expect(Object.keys(routeModule).length).toBeGreaterThan(0);
  });
});
