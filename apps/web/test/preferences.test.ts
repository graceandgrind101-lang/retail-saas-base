import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { signSessionCookie } from "@retail/core";
import { createTenantDb, type TenantDb } from "@retail/db";
import { createAdminDb, provisionTenant, type AdminDb } from "@retail/db/admin";
import { LOCALES, getMessages, messageAt } from "@retail/i18n";
import { newUuid } from "./ids";
import { createPreferenceHandlers } from "../lib/preferences/handlers";
import { calendarCookieHeader, languageCookieHeader } from "../lib/preferences/cookies";
import { preferencesFromCookies } from "../lib/preferences/resolve";

const APP_URL = "http://localhost:3000";
const SESSION_SECRET = "k3Jf9aQ2xLm7ZpR1tVb8nWc4yHd6sGu0";

let admin: AdminDb;
let db: TenantDb;
let handlers: ReturnType<typeof createPreferenceHandlers>;

beforeAll(() => {
  admin = createAdminDb(inject("adminUrl"), { max: 3 });
  db = createTenantDb(inject("appUrl"), { max: 4 });
  handlers = createPreferenceHandlers({ db, sessionSecret: SESSION_SECRET, appUrl: APP_URL });
});
afterAll(async () => {
  await db.close();
  await admin.close();
});

function post(body: unknown, options: { origin?: string | null; cookie?: string; raw?: string } = {}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  const origin = options.origin === undefined ? APP_URL : options.origin;
  if (origin !== null) headers.set("origin", origin);
  if (options.cookie) headers.set("cookie", options.cookie);
  return new Request(`${APP_URL}/api/preferences`, { method: "POST", headers, body: options.raw ?? JSON.stringify(body) });
}

const cookiesOf = (response: Response): string[] => response.headers.getSetCookie();

describe("which language and calendar a request gets", () => {
  const from = (jar: Record<string, string>) => preferencesFromCookies((name) => jar[name]);

  it("English and Gregorian when nothing is asked", () => {
    expect(from({})).toEqual({ locale: "en", calendar: "gregorian" });
  });
  it("follows the browser's choice", () => {
    expect(from({ retail_lang: "am", retail_cal: "ethiopian" })).toEqual({ locale: "am", calendar: "ethiopian" });
  });
  it("ignores values that are not offered or are malformed, rather than trusting a cookie", () => {
    for (const bad of ["fr", "", "%E0%A4%A", "../../etc", "am%00", "__proto__"]) {
      expect(from({ retail_lang: bad, retail_cal: bad }), bad).toEqual({ locale: "en", calendar: "gregorian" });
    }
  });
});

describe("the preference cookies", () => {
  it("are plain, scoped to the whole app, a year long, and Secure over https", () => {
    expect(languageCookieHeader("http://localhost:3000", "am")).toBe("retail_lang=am; Path=/; SameSite=Lax; Max-Age=31536000");
    expect(calendarCookieHeader("https://app.example.com", "ethiopian")).toBe("retail_cal=ethiopian; Path=/; SameSite=Lax; Max-Age=31536000; Secure");
  });
});

describe("POST /api/preferences", () => {
  it("sets the cookies for what was chosen, and only that", async () => {
    const both = await handlers.set(post({ language: "am", calendar: "ethiopian" }));
    expect(both.status).toBe(200);
    expect(await both.json()).toEqual({ language: "am", calendar: "ethiopian", saved: false });
    expect(cookiesOf(both)).toEqual([languageCookieHeader(APP_URL, "am"), calendarCookieHeader(APP_URL, "ethiopian")]);

    const lang = await handlers.set(post({ language: "en" }));
    expect(cookiesOf(lang)).toEqual([languageCookieHeader(APP_URL, "en")]);
    const cal = await handlers.set(post({ calendar: "gregorian" }));
    expect(cookiesOf(cal)).toEqual([calendarCookieHeader(APP_URL, "gregorian")]);
  });

  it("refuses languages that are not offered, unknown calendars, empty and malformed requests", async () => {
    for (const body of [{ language: "fr" }, { language: "" }, { language: 5 }, { calendar: "julian" }, { calendar: "Ethiopian" }, {}, { language: "am", extra: 1 }]) {
      const response = await handlers.set(post(body));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toEqual({ error: "bad_request" });
      expect(cookiesOf(response)).toEqual([]);
    }
    expect((await handlers.set(post(null, { raw: "not json" }))).status).toBe(400);
  });

  it("only from the app's own pages", async () => {
    expect((await handlers.set(post({ language: "am" }, { origin: null }))).status).toBe(403);
    expect((await handlers.set(post({ language: "am" }, { origin: "http://evil.example" }))).status).toBe(403);
  });

  it("when someone is signed in, the choice is saved on their own record and nobody else's", async () => {
    const email = `owner-${randomBytes(4).toString("hex")}@example.com`;
    const shop = await provisionTenant(admin.sql, { slug: `prefs-${randomBytes(4).toString("hex")}`, displayName: { en: "Prefs" }, industry: "other", planKey: "pro", owner: { email, displayName: "Owner" } });
    const staffId = newUuid();
    const other = newUuid();
    const sessionId = newUuid();
    for (const id of [staffId, other]) {
      await admin.sql`insert into app.staff (id, tenant_id, display_name, role_id, status) values (${id}, ${shop.tenantId}, 'Someone', ${shop.roleIds.cashier}, 'active')`;
    }
    await admin.sql`insert into app.staff_sessions (id, tenant_id, staff_id, method, expires_at) values (${sessionId}, ${shop.tenantId}, ${staffId}, 'password', now() + interval '1 day')`;
    const value = await signSessionCookie({ tenantId: shop.tenantId, staffId, sessionId, expiresAt: Math.floor(Date.now() / 1000) + 3600 }, SESSION_SECRET);
    const cookie = `retail_session=${value}`;

    const response = await handlers.set(post({ language: "am", calendar: "ethiopian" }, { cookie }));
    expect(await response.json()).toEqual({ language: "am", calendar: "ethiopian", saved: true });
    const rows = await admin.sql`select id, preferred_language, preferred_calendar from app.staff where id in (${staffId}, ${other})`;
    expect(rows.find((r) => r.id === staffId)).toMatchObject({ preferred_language: "am", preferred_calendar: "ethiopian" });
    expect(rows.find((r) => r.id === other)).toMatchObject({ preferred_language: null, preferred_calendar: null });

    // a later change of one thing leaves the other alone
    await handlers.set(post({ language: "en" }, { cookie }));
    const [again] = await admin.sql`select preferred_language, preferred_calendar from app.staff where id = ${staffId}`;
    expect(again).toMatchObject({ preferred_language: "en", preferred_calendar: "ethiopian" });
  });

  it("an ended sign-in does not stop the browser from remembering the choice", async () => {
    const shop = await provisionTenant(admin.sql, { slug: `prefs2-${randomBytes(4).toString("hex")}`, displayName: { en: "Prefs" }, industry: "other", planKey: "pro" });
    const staffId = newUuid();
    const sessionId = newUuid();
    await admin.sql`insert into app.staff (id, tenant_id, display_name, role_id, status) values (${staffId}, ${shop.tenantId}, 'Someone', ${shop.roleIds.cashier}, 'active')`;
    await admin.sql`insert into app.staff_sessions (id, tenant_id, staff_id, method, expires_at) values (${sessionId}, ${shop.tenantId}, ${staffId}, 'password', now() + interval '1 day')`;
    await admin.sql`update app.staff_sessions set ended_at = now(), ended_reason = 'logout' where id = ${sessionId}`;
    const value = await signSessionCookie({ tenantId: shop.tenantId, staffId, sessionId, expiresAt: Math.floor(Date.now() / 1000) + 3600 }, SESSION_SECRET);
    const response = await handlers.set(post({ language: "am" }, { cookie: `retail_session=${value}` }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ language: "am", calendar: null, saved: false });
    expect(cookiesOf(response)).toEqual([languageCookieHeader(APP_URL, "am")]);
  });
});

describe("every error the API can send has words in every language", () => {
  const libDir = join(__dirname, "..", "lib");
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? sources(full) : full.endsWith(".ts") ? [full] : [];
    });
  const codes = new Set<string>();
  for (const file of sources(libDir)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\berror: "([a-z_]+)"/g)) codes.add(m[1] as string);
    for (const m of text.matchAll(/new HttpError\(\d+, "([a-z_]+)"\)/g)) codes.add(m[1] as string);
  }

  it("finds the codes it should (guards the test itself)", () => {
    for (const expected of ["unauthenticated", "forbidden", "wrong_pin", "locked", "last_owner", "bad_origin", "session_ended", "pairing_invalid"]) {
      expect(codes.has(expected), expected).toBe(true);
    }
  });

  it("has text for each, in each offered language", () => {
    const missing: string[] = [];
    for (const l of LOCALES) {
      const messages = getMessages(l.code);
      for (const code of codes) if (messageAt(messages, `errors.${code}`) === undefined) missing.push(`${l.code}: errors.${code}`);
    }
    expect(missing).toEqual([]);
  });
});
