import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADMIN_NAV, ALERT_CATEGORIES, ALERT_RULES, ALERT_STATUSES, MODULE_KEYS, PERMISSION_KEYS, POS_TABS, SYSTEM_ROLE_KEYS } from "@retail/core";
import { checkLocales } from "./check";
import {
  ALL_LOCALES,
  CALENDARS,
  DEFAULT_LOCALE,
  LOCALES,
  getMessages,
  isCalendar,
  isLocale,
  messageAt,
  offeredLocales,
  permissionMessagePath,
  pickText,
  resolveCalendar,
  resolveLocale,
} from "./locales";

const messagesDir = join(__dirname, "..", "messages");

describe("the shipped message files", () => {
  const files = Object.fromEntries(readdirSync(messagesDir).filter((f) => f.endsWith(".json")).map((f) => [f.slice(0, -5), JSON.parse(readFileSync(join(messagesDir, f), "utf8")) as unknown]));

  it("are complete and well formed (the same check CI runs)", () => {
    expect(checkLocales(files)).toEqual([]);
  });

  it("include English and Amharic, each under its own name", () => {
    expect(ALL_LOCALES.map((l) => [l.code, l.name])).toEqual([["am", "አማርኛ"], ["en", "English"]]);
    expect(LOCALES.map((l) => l.code)).toEqual(["am", "en"]);
  });

  it("the registry holds exactly the files in the folder (nothing stale, nothing missing)", () => {
    expect(ALL_LOCALES.map((l) => l.code).sort()).toEqual(Object.keys(files).sort());
  });
});

describe("every name the system defines has text in every language", () => {
  const has = (path: string) => LOCALES.map((l) => [l.code, messageAt(getMessages(l.code), path)] as const).filter(([, text]) => text === undefined || text === "").map(([code]) => code);

  it("permissions", () => {
    for (const key of PERMISSION_KEYS) expect(has(permissionMessagePath(key)), key).toEqual([]);
  });
  it("roles, modules, alert categories, statuses and rules", () => {
    for (const key of SYSTEM_ROLE_KEYS) expect(has(`roles.${key}`), key).toEqual([]);
    for (const key of MODULE_KEYS) expect(has(`modules.${key}`), key).toEqual([]);
    for (const key of ALERT_CATEGORIES) expect(has(`alerts.category.${key}`), key).toEqual([]);
    for (const key of ALERT_STATUSES) expect(has(`alerts.status.${key}`), key).toEqual([]);
    for (const key of Object.keys(ALERT_RULES)) expect(has(`alerts.rule.${key}`), key).toEqual([]);
  });
  it("the thirteen Ethiopian months and the pin problems", () => {
    for (let m = 1; m <= 13; m++) expect(has(`calendar.ethiopian_month.${m}`), String(m)).toEqual([]);
    for (const p of ["not_digits", "too_short", "too_long", "too_easy"]) expect(has(`pin.problem.${p}`), p).toEqual([]);
  });
  it("every menu item and POS tab (so a new screen cannot ship without its name)", () => {
    for (const item of ADMIN_NAV) expect(has(`nav.${item.key}`), item.key).toEqual([]);
    for (const tab of POS_TABS) expect(has(`pos.tabs.${tab.key}`), tab.key).toEqual([]);
  });
  it("has no text for a key that is not defined (guards the test itself)", () => {
    expect(has("permissions.nope.nope")).toEqual(["am", "en"]);
  });
});

describe("the language picker", () => {
  it("offers each finished language under its own name and holds back unfinished ones", () => {
    expect(
      offeredLocales([
        { code: "am", name: "አማርኛ", hidden: false },
        { code: "en", name: "English", hidden: false },
        { code: "om", name: "Afaan Oromoo", hidden: true },
      ]),
    ).toEqual([{ code: "am", name: "አማርኛ" }, { code: "en", name: "English" }]);
    expect(offeredLocales([])).toEqual([]);
  });
});

describe("choosing a language", () => {
  it("English is the default", () => {
    expect(DEFAULT_LOCALE).toBe("en");
    expect(resolveLocale({})).toBe("en");
    expect(resolveLocale({ user: null, shop: null })).toBe("en");
  });

  it("the person's choice beats the shop's, which beats the default", () => {
    expect(resolveLocale({ user: "am", shop: "en" })).toBe("am");
    expect(resolveLocale({ shop: "am" })).toBe("am");
    expect(resolveLocale({ user: null, shop: "am" })).toBe("am");
  });

  it("anything that is not an offered language is skipped, never trusted", () => {
    for (const bad of ["fr", "", "AM", "am ", "../am", "__proto__", "constructor", "en\u0000"]) {
      expect(resolveLocale({ user: bad }), bad).toBe("en");
      expect(resolveLocale({ user: bad, shop: "am" }), bad).toBe("am");
    }
    expect(isLocale("am")).toBe(true);
    expect(isLocale(5)).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });

  it("messages of an unknown language are English's, and never include the _meta block", () => {
    expect(getMessages("fr")).toEqual(getMessages("en"));
    expect("_meta" in getMessages("en")).toBe(false);
    expect(messageAt(getMessages("am"), "common.save")).toBe("አስቀምጥ");
  });
});

describe("choosing a calendar", () => {
  it("Gregorian unless the person or the shop chose Ethiopian", () => {
    expect(resolveCalendar({})).toBe("gregorian");
    expect(resolveCalendar({ shop: "ethiopian" })).toBe("ethiopian");
    expect(resolveCalendar({ user: "gregorian", shop: "ethiopian" })).toBe("gregorian");
    expect(resolveCalendar({ user: "ethiopian", shop: "gregorian" })).toBe("ethiopian");
    expect(resolveCalendar({ user: "julian", shop: "ethiopian" })).toBe("ethiopian");
    expect(resolveCalendar({ user: "lunar", shop: "lunar" })).toBe("gregorian");
    expect([...CALENDARS]).toEqual(["gregorian", "ethiopian"]);
    expect(isCalendar("ethiopian")).toBe(true);
    expect(isCalendar("Ethiopian")).toBe(false);
  });
});

describe("looking up a message", () => {
  const tree = { a: { b: "text", c: { d: "deep" } }, e: "top" };
  it("finds text by dotted path and nothing else", () => {
    expect(messageAt(tree, "a.b")).toBe("text");
    expect(messageAt(tree, "a.c.d")).toBe("deep");
    expect(messageAt(tree, "e")).toBe("top");
    for (const path of ["", "a", "a.c", "a.b.x", "x", "a.x", "toString", "a.__proto__", "constructor"]) expect(messageAt(tree, path), path).toBeUndefined();
  });
  it("names a permission's text", () => {
    expect(permissionMessagePath("sale:below_floor")).toBe("permissions.sale.below_floor");
  });
});

describe("a shop's own text in the person's language", () => {
  it("takes their language if the shop wrote one, then English, then anything", () => {
    expect(pickText({ en: "Demo", am: "ናሙና" }, "am")).toBe("ናሙና");
    expect(pickText({ en: "Demo", am: "ናሙና" }, "en")).toBe("Demo");
    expect(pickText({ en: "Demo" }, "am")).toBe("Demo");
    expect(pickText({ om: "Fakkeenya" }, "am")).toBe("Fakkeenya");
    expect(pickText({ am: "", en: "Demo" }, "am")).toBe("Demo");
  });
  it("is empty rather than failing when there is nothing", () => {
    expect(pickText({}, "en")).toBe("");
    expect(pickText(null, "en")).toBe("");
    expect(pickText(undefined, "am")).toBe("");
    expect(pickText({ en: "", am: "" }, "am")).toBe("");
  });
});
