import { describeLocales, type LocaleFileInfo } from "./check";
import { MESSAGES } from "./generated/registry";

/** English is the default language (PLAN.md D22). A shop or a person can pick another. */
export const DEFAULT_LOCALE = "en";

export type Messages = { [key: string]: string | Messages };

/** Every language file there is, including ones held back from the picker. */
export const ALL_LOCALES: readonly LocaleFileInfo[] = describeLocales(MESSAGES);

/** What the language picker offers: each language's own name; hidden (unfinished) ones are left out. */
export function offeredLocales(infos: readonly LocaleFileInfo[]): { code: string; name: string }[] {
  return infos.filter((l) => !l.hidden).map(({ code, name }) => ({ code, name }));
}
export const LOCALES: readonly { code: string; name: string }[] = offeredLocales(ALL_LOCALES);

export function isLocale(value: unknown): value is string {
  return typeof value === "string" && LOCALES.some((l) => l.code === value);
}

/** The messages of a language; English for anything that is not an offered language. */
export function getMessages(locale: string): Messages {
  const code = isLocale(locale) ? locale : DEFAULT_LOCALE;
  const { _meta: _ignored, ...messages } = (MESSAGES[code] ?? MESSAGES[DEFAULT_LOCALE]) as Messages;
  return messages;
}

/**
 * Which language to show: the person's own choice, else the shop's default, else English.
 * A value that is not an offered language is skipped, never trusted (it may come from a cookie).
 */
export function resolveLocale(choices: { user?: string | null; shop?: string | null }): string {
  for (const choice of [choices.user, choices.shop]) if (isLocale(choice)) return choice;
  return DEFAULT_LOCALE;
}

export type CalendarKind = "gregorian" | "ethiopian";
export const CALENDARS: readonly CalendarKind[] = ["gregorian", "ethiopian"];

export function isCalendar(value: unknown): value is CalendarKind {
  return value === "gregorian" || value === "ethiopian";
}

/** Gregorian unless the person, or failing that the shop, chose the Ethiopian calendar (PLAN.md D23). */
export function resolveCalendar(choices: { user?: string | null; shop?: string | null }): CalendarKind {
  for (const choice of [choices.user, choices.shop]) if (isCalendar(choice)) return choice;
  return "gregorian";
}

/** The text at a dotted path, or undefined. */
export function messageAt(messages: Messages, path: string): string | undefined {
  let node: string | Messages | undefined = messages;
  for (const part of path.split(".")) {
    if (typeof node !== "object" || node === null || !Object.prototype.hasOwnProperty.call(node, part)) return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

/** The path of a permission's label: `sale:below_floor` is `permissions.sale.below_floor`. */
export const permissionMessagePath = (key: string): string => `permissions.${key.replace(":", ".")}`;
