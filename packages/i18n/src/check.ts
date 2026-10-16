import { TYPE, parse, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";

/**
 * The checks that keep every language complete and safe (docs/SCREENS.md §0.1, CLAUDE.md
 * bilingual rule). `en.json` is the source of truth: every other language must have the same
 * keys, and every message must take the same arguments with the same kinds (a plural stays a
 * plural), so a translation can never crash the page or print a raw `{name}`.
 *
 * A file may mark itself `"_meta": { "hidden": true }` to be held back from the language picker
 * while it is still being translated; a hidden language may lack keys but must still be well
 * formed wherever it does have text.
 */

export interface MessageProblem {
  locale: string;
  /** The dotted path of the message, or null for a problem with the whole file. */
  key: string | null;
  problem: string;
}

/** Letters, digits and underscore only: a dot separates levels and must never appear in a name. */
const KEY_SEGMENT = /^[A-Za-z0-9_]+$/;
const LOCALE_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export const META_KEY = "_meta";

export function isLocaleCode(value: string): boolean {
  return LOCALE_CODE.test(value);
}

/** `{ a: { b: "x" } }` becomes `a.b` to `x`. Anything that is neither text nor a group is reported. */
export function flattenMessages(tree: unknown, prefix = ""): { entries: Map<string, string>; problems: { key: string; problem: string }[] } {
  const entries = new Map<string, string>();
  const problems: { key: string; problem: string }[] = [];
  const walk = (node: unknown, path: string) => {
    if (typeof node === "string") {
      entries.set(path, node);
      return;
    }
    if (typeof node === "object" && node !== null && !Array.isArray(node)) {
      for (const [name, child] of Object.entries(node)) {
        if (path === "" && name === META_KEY) continue;
        const next = path === "" ? name : `${path}.${name}`;
        if (!KEY_SEGMENT.test(name)) {
          problems.push({ key: next, problem: `the name "${name}" may only use letters, digits and underscores` });
          continue;
        }
        walk(child, next);
      }
      return;
    }
    problems.push({ key: path, problem: "must be text or a group of messages" });
  };
  walk(tree, prefix);
  return { entries, problems };
}

/** The arguments a message takes, as `name:kind`. Throws if the message is not valid ICU. */
export function icuArguments(message: string): Set<string> {
  const found = new Set<string>();
  const walk = (elements: MessageFormatElement[]) => {
    for (const el of elements) {
      switch (el.type) {
        case TYPE.argument:
          found.add(`${el.value}:argument`);
          break;
        case TYPE.number:
          found.add(`${el.value}:number`);
          break;
        case TYPE.date:
          found.add(`${el.value}:date`);
          break;
        case TYPE.time:
          found.add(`${el.value}:time`);
          break;
        case TYPE.select:
        case TYPE.plural:
          found.add(`${el.value}:${el.type === TYPE.plural ? "plural" : "select"}`);
          for (const option of Object.values(el.options)) walk(option.value);
          break;
        case TYPE.tag:
          found.add(`${el.value}:tag`);
          walk(el.children);
          break;
        default:
          break; // literal text and the # in a plural
      }
    }
  };
  walk(parse(message));
  return found;
}

export interface LocaleFileInfo {
  code: string;
  name: string;
  hidden: boolean;
}

function metaOf(file: unknown): { name?: unknown; hidden?: unknown } | null {
  if (typeof file !== "object" || file === null) return null;
  const meta = (file as Record<string, unknown>)[META_KEY];
  return typeof meta === "object" && meta !== null && !Array.isArray(meta) ? (meta as { name?: unknown; hidden?: unknown }) : null;
}

/** What each language file says about itself (only for files whose `_meta` is well formed). */
export function describeLocales(files: Record<string, unknown>): LocaleFileInfo[] {
  return Object.keys(files)
    .sort()
    .flatMap((code) => {
      const meta = metaOf(files[code]);
      if (!meta || typeof meta.name !== "string" || meta.name.trim() === "") return [];
      return [{ code, name: meta.name, hidden: meta.hidden === true }];
    });
}

/** All the problems in a set of language files, `source` being the one that defines every key. */
export function checkLocales(files: Record<string, unknown>, source = "en"): MessageProblem[] {
  const problems: MessageProblem[] = [];
  const add = (locale: string, key: string | null, problem: string) => problems.push({ locale, key, problem });

  if (!(source in files)) {
    add(source, null, `the source language "${source}" has no message file`);
    return problems;
  }

  const flat = new Map<string, Map<string, string>>();
  for (const [locale, file] of Object.entries(files)) {
    if (!isLocaleCode(locale)) add(locale, null, `"${locale}" is not a valid language code (use e.g. en, am, om, ti)`);
    const meta = metaOf(file);
    if (!meta) add(locale, null, `missing "_meta" with the language's own name`);
    else {
      if (typeof meta.name !== "string" || meta.name.trim() === "") add(locale, "_meta.name", "the language needs a display name in its own language");
      if (meta.hidden !== undefined && typeof meta.hidden !== "boolean") add(locale, "_meta.hidden", "must be true or false");
      if (locale === source && meta.hidden === true) add(locale, "_meta.hidden", "the source language cannot be hidden");
    }
    const { entries, problems: structural } = flattenMessages(file);
    for (const p of structural) add(locale, p.key, p.problem);
    flat.set(locale, entries);
    for (const [key, text] of entries) {
      if (text.trim() === "") {
        add(locale, key, "is empty");
        continue;
      }
      try {
        icuArguments(text);
      } catch (error) {
        add(locale, key, `is not a valid message: ${error instanceof Error ? error.message : "parse error"}`);
      }
    }
  }

  const sourceEntries = flat.get(source) ?? new Map<string, string>();
  for (const [locale, entries] of flat) {
    if (locale === source) continue;
    const hidden = metaOf(files[locale])?.hidden === true;
    for (const [key, text] of sourceEntries) {
      const translated = entries.get(key);
      if (translated === undefined) {
        if (!hidden) add(locale, key, "is missing (the source language has it)");
        continue;
      }
      let expected: Set<string>;
      let actual: Set<string>;
      try {
        expected = icuArguments(text);
        actual = icuArguments(translated);
      } catch {
        continue; // reported above as invalid
      }
      const lacking = [...expected].filter((a) => !actual.has(a));
      const surplus = [...actual].filter((a) => !expected.has(a));
      if (lacking.length > 0) add(locale, key, `is missing ${lacking.map((a) => `{${a}}`).join(", ")}`);
      if (surplus.length > 0) add(locale, key, `has ${surplus.map((a) => `{${a}}`).join(", ")} that the source does not`);
    }
    for (const key of entries.keys()) {
      if (!sourceEntries.has(key)) add(locale, key, "does not exist in the source language");
    }
  }
  return problems;
}

export function formatProblems(problems: readonly MessageProblem[]): string {
  return problems.map((p) => `  ${p.locale}${p.key ? `: ${p.key}` : ""}: ${p.problem}`).join("\n");
}
