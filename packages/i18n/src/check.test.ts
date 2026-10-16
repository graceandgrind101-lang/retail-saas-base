import { describe, expect, it } from "vitest";
import { checkLocales, describeLocales, flattenMessages, formatProblems, icuArguments, isLocaleCode } from "./check";
import { renderRegistry } from "./registry-source";

const en = { _meta: { name: "English" }, hello: "Hello", paid: "Paid {amount} by {method}", items: "{count, plural, one {# item} other {# items}}", group: { deep: "Deep {n, number}" } };
const good = { _meta: { name: "Other" }, hello: "Salam", paid: "{method} {amount}", items: "{count, plural, one {# x} other {# xs}}", group: { deep: "{n, number} deep" } };

const problems = (files: Record<string, unknown>) => checkLocales(files);
const only = (files: Record<string, unknown>) => problems(files).map((p) => `${p.locale}|${p.key ?? "-"}|${p.problem}`);

describe("complete languages pass", () => {
  it("a language with every key and the same arguments has no problems", () => {
    expect(problems({ en, xx: good })).toEqual([]);
  });
  it("word order and plural wording may differ; only the arguments must match", () => {
    expect(problems({ en, xx: { ...good, items: "{count, plural, one {# a} few {# b} other {# c}}" } })).toEqual([]);
  });
});

describe("what fails the build", () => {
  it("a missing key", () => {
    const { hello: _gone, ...rest } = good;
    expect(only({ en, xx: rest })).toEqual(["xx|hello|is missing (the source language has it)"]);
  });

  it("a missing key deep in a group", () => {
    expect(only({ en, xx: { ...good, group: {} } })).toEqual(["xx|group.deep|is missing (the source language has it)"]);
  });

  it("a key the source does not have", () => {
    expect(only({ en, xx: { ...good, extra: "Surplus" } })).toEqual(["xx|extra|does not exist in the source language"]);
  });

  it("a lost placeholder", () => {
    expect(only({ en, xx: { ...good, paid: "Paid {amount}" } })).toEqual(["xx|paid|is missing {method:argument}"]);
  });

  it("a renamed placeholder (both a loss and a surplus)", () => {
    expect(only({ en, xx: { ...good, paid: "{amount} {methode}" } })).toEqual([
      "xx|paid|is missing {method:argument}",
      "xx|paid|has {methode:argument} that the source does not",
    ]);
  });

  it("a plural turned into a plain placeholder, and a number into text", () => {
    expect(only({ en, xx: { ...good, items: "{count} items" } })).toEqual(["xx|items|is missing {count:plural}", "xx|items|has {count:argument} that the source does not"]);
    expect(only({ en, xx: { ...good, group: { deep: "{n} deep" } } })).toEqual(["xx|group.deep|is missing {n:number}", "xx|group.deep|has {n:argument} that the source does not"]);
  });

  it("a placeholder hidden inside a plural branch counts", () => {
    const nested = { ...en, items: "{count, plural, one {{who} has # item} other {{who} has # items}}" };
    expect(only({ en: nested, xx: { ...good, items: "{count, plural, one {# x} other {# xs}}" } })).toEqual(["xx|items|is missing {who:argument}"]);
  });

  it("broken message syntax, in any language including the source", () => {
    expect(only({ en, xx: { ...good, hello: "Hello {name" } })[0]).toMatch(/^xx\|hello\|is not a valid message/);
    expect(only({ en: { ...en, hello: "Hello {name" }, xx: good })[0]).toMatch(/^en\|hello\|is not a valid message/);
    expect(only({ en, xx: { ...good, items: "{count, plural, one {# x}}" } })[0]).toMatch(/^xx\|items\|is not a valid message/); // no 'other'
  });

  it("empty text and things that are not text", () => {
    expect(only({ en, xx: { ...good, hello: "   " } })).toEqual(["xx|hello|is empty"]);
    expect(only({ en, xx: { ...good, hello: 5 } })).toContain("xx|hello|must be text or a group of messages");
    expect(only({ en, xx: { ...good, hello: ["a"] } })).toContain("xx|hello|must be text or a group of messages");
    expect(only({ en, xx: { ...good, hello: null } })).toContain("xx|hello|must be text or a group of messages");
  });

  it("a key name that would break the dotted path", () => {
    expect(only({ en, xx: { ...good, "a.b": "x" } }).join("\n")).toContain("may only use letters, digits and underscores");
    expect(only({ en, xx: { ...good, "a:b": "x" } }).join("\n")).toContain("may only use letters, digits and underscores");
  });

  it("a language without a display name, or a bad code, or a broken _meta", () => {
    expect(only({ en, xx: { ...good, _meta: {} } })).toContain("xx|_meta.name|the language needs a display name in its own language");
    expect(only({ en, xx: { ...good, _meta: { name: "  " } } })).toContain("xx|_meta.name|the language needs a display name in its own language");
    const { _meta: _m, ...noMeta } = good;
    expect(only({ en, xx: noMeta })).toContain(`xx|-|missing "_meta" with the language's own name`);
    expect(only({ en, xx: { ...good, _meta: { name: "X", hidden: "yes" } } })).toContain("xx|_meta.hidden|must be true or false");
    expect(only({ en, "Not A Code": good }).join("\n")).toContain("is not a valid language code");
    expect(only({ en, "xx!": good }).join("\n")).toContain("is not a valid language code");
  });

  it("no source language at all", () => {
    expect(only({ xx: good })).toEqual([`en|-|the source language "en" has no message file`]);
  });

  it("the source language cannot be hidden", () => {
    expect(only({ en: { ...en, _meta: { name: "English", hidden: true } } })).toContain("en|_meta.hidden|the source language cannot be hidden");
  });
});

describe("a language still being translated can be held back", () => {
  it("a hidden language may lack keys, but what it has must still be right", () => {
    const partial = { _meta: { name: "Partial", hidden: true }, hello: "Salam" };
    expect(problems({ en, xx: partial })).toEqual([]);
    expect(only({ en, xx: { ...partial, paid: "Paid {amount}" } })).toEqual(["xx|paid|is missing {method:argument}"]);
    expect(only({ en, xx: { ...partial, extra: "x" } })).toEqual(["xx|extra|does not exist in the source language"]);
  });
});

describe("helpers", () => {
  it("flattens groups into dotted paths and skips _meta", () => {
    expect([...flattenMessages(en).entries.keys()]).toEqual(["hello", "paid", "items", "group.deep"]);
  });

  it("lists the arguments of a message by name and kind", () => {
    expect([...icuArguments("Hi {a}, {b, number}, {c, date}, {d, time}, {e, select, x {X} other {O}}, <b>{f}</b>")].sort()).toEqual(
      ["a:argument", "b:number", "c:date", "d:time", "e:select", "f:argument", "b:tag"].sort(),
    );
    expect([...icuArguments("plain text")]).toEqual([]);
    expect(() => icuArguments("{unclosed")).toThrow();
  });

  it("describes languages by their own names and drops files with no usable name", () => {
    expect(describeLocales({ en, am: { _meta: { name: "አማርኛ" } }, zz: { hello: "x" }, yy: { _meta: { name: "" } }, hid: { _meta: { name: "Hidden", hidden: true } } })).toEqual([
      { code: "am", name: "አማርኛ", hidden: false },
      { code: "en", name: "English", hidden: false },
      { code: "hid", name: "Hidden", hidden: true },
    ]);
  });

  it("accepts real language codes only", () => {
    for (const ok of ["en", "am", "om", "ti", "en-GB", "pt-BR"]) expect(isLocaleCode(ok), ok).toBe(true);
    for (const bad of ["", "e", "english", "EN", "en_GB", "en-", "../x", "en.json"]) expect(isLocaleCode(bad), bad).toBe(false);
  });

  it("formats problems one per line", () => {
    expect(formatProblems([{ locale: "am", key: "a.b", problem: "is missing" }, { locale: "am", key: null, problem: "bad file" }])).toBe("  am: a.b: is missing\n  am: bad file");
  });
});

describe("the generated registry", () => {
  it("imports each file, sorted, and is the same however the codes are ordered", () => {
    const text = renderRegistry(["en", "am", "pt-BR"]);
    expect(text).toBe(renderRegistry(["pt-BR", "am", "en"]));
    expect(text).toContain('import messages_am from "../../messages/am.json";');
    expect(text).toContain('import messages_pt_BR from "../../messages/pt-BR.json";');
    expect(text).toContain('  "pt-BR": messages_pt_BR,');
    expect(text.indexOf("messages_am")).toBeLessThan(text.indexOf("messages_en"));
    expect(text.endsWith("\n")).toBe(true);
  });
});
