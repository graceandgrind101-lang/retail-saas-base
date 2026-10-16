import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODULE_KEYS } from "@retail/core";
import { contrastRatio, parseTokens, resolveColor, type Rgb } from "./testing/colors";

const css = readFileSync(join(__dirname, "styles", "tokens.css"), "utf8");
const themes = { light: parseTokens(css, ":root"), dark: { ...parseTokens(css, ":root"), ...parseTokens(css, ':root[data-theme="dark"]') } };

const color = (theme: "light" | "dark", name: string): Rgb => resolveColor(themes[theme], name);
const ratio = (theme: "light" | "dark", fg: string, bg: string) => contrastRatio(color(theme, fg), color(theme, bg));

/** Text pairs: WCAG AA for normal text is 4.5:1. */
const TEXT_PAIRS: [string, string][] = [
  ["--text", "--bg"],
  ["--text", "--surface"],
  ["--text", "--surface-2"],
  ["--text-muted", "--bg"],
  ["--text-muted", "--surface"],
  ["--text-muted", "--surface-2"],
  ["--link", "--bg"],
  ["--link", "--surface"],
  ["--on-accent", "--accent"],
  ["--on-accent", "--accent-hover"],
  ["--on-danger", "--danger"],
  ["--ok-fg", "--ok-bg"],
  ["--warn-fg", "--warn-bg"],
  ["--bad-fg", "--bad-bg"],
  ["--note-fg", "--note-bg"],
  ["--trend-up", "--surface"],
  ["--trend-down", "--surface"],
  ["--trend-up", "--bg"],
  ["--trend-down", "--bg"],
  ...["fraud", "suspicion", "error", "alert", "message", "info"].map((c): [string, string] => [`--cat-${c}-fg`, `--cat-${c}-bg`]),
  ...["a", "b", "c", "d"].flatMap((t): [string, string][] => [
    ["--tile-fg", `--tile-${t}-bg`],
    ["--tile-fg", `--tile-${t}-strip`],
  ]),
  ...["cash", "telebirr", "cbe", "bank", "dube"].map((m): [string, string] => ["--on-pay", `--pay-${m}`]),
];

/** Non-text pairs (icons, the focus ring, module bars): WCAG AA for graphics is 3:1. */
const GRAPHIC_PAIRS: [string, string][] = [
  ["--accent", "--surface"],
  ["--accent", "--bg"],
  ["--focus", "--surface"],
  ["--focus", "--bg"],
  ["--danger", "--surface"],
  ...MODULE_KEYS.map((m): [string, string] => [`--mod-${m}`, "--surface"]),
  ...["cash", "telebirr", "cbe", "bank", "dube"].map((m): [string, string] => [`--pay-${m}`, "--surface"]),
];

for (const theme of ["light", "dark"] as const) {
  describe(`${theme} theme`, () => {
    it.each(TEXT_PAIRS)("text %s on %s is at least 4.5:1", (fg, bg) => {
      expect(ratio(theme, fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    });

    it.each(GRAPHIC_PAIRS)("graphic %s against %s is at least 3:1", (fg, bg) => {
      expect(ratio(theme, fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
    });
  });
}

describe("the tokens file itself", () => {
  it("defines every pair's colours in both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      for (const name of new Set([...TEXT_PAIRS, ...GRAPHIC_PAIRS].flat())) expect(() => color(theme, name), `${theme} ${name}`).not.toThrow();
    }
  });

  it("the dark theme redefines every colour the light theme does (nothing left light by accident)", () => {
    const light = Object.keys(parseTokens(css, ":root")).filter((n) => /^--(bg|surface|border|text|link|accent|focus|danger|on-|ok-|warn-|bad-|note-|trend-|cat-|tile-|pay-|mod-|skeleton|scrim)/.test(n));
    const dark = new Set(Object.keys(parseTokens(css, ':root[data-theme="dark"]')));
    // --brand-hue and the sizes are shared; every colour must be restated
    expect(light.filter((n) => !dark.has(n))).toEqual([]);
  });

  it("every module has an accent and every payment method a colour (U6)", () => {
    for (const m of MODULE_KEYS) expect(themes.light[`--mod-${m}`], m).toBeDefined();
    for (const m of ["cash", "telebirr", "cbe", "bank", "dube"]) expect(themes.light[`--pay-${m}`], m).toBeDefined();
  });

  it("a shop's brand is only a hue, so any hue keeps the accent's contrast", () => {
    for (const hue of [0, 30, 60, 90, 120, 150, 180, 210, 240, 262, 300, 330]) {
      for (const theme of ["light", "dark"] as const) {
        const tokens = { ...themes[theme], "--brand-hue": String(hue) };
        const onAccent = contrastRatio(resolveColor(tokens, "--on-accent"), resolveColor(tokens, "--accent"));
        const link = contrastRatio(resolveColor(tokens, "--link"), resolveColor(tokens, "--surface"));
        expect(onAccent, `hue ${hue} ${theme} button text`).toBeGreaterThanOrEqual(4.5);
        expect(link, `hue ${hue} ${theme} link`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("the colour maths is right (known values)", () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 1, g: 1, b: 1 })).toBeCloseTo(21, 5);
    expect(contrastRatio({ r: 1, g: 1, b: 1 }, { r: 1, g: 1, b: 1 })).toBeCloseTo(1, 5);
    // #767676 on white is the classic 4.54:1
    expect(contrastRatio({ r: 0x76 / 255, g: 0x76 / 255, b: 0x76 / 255 }, { r: 1, g: 1, b: 1 })).toBeCloseTo(4.54, 2);
    const white = resolveColor({ "--w": "oklch(100% 0 0)" }, "--w");
    expect([white.r, white.g, white.b].every((v) => Math.abs(v - 1) < 1e-3)).toBe(true);
    const black = resolveColor({ "--b": "oklch(0% 0 0)" }, "--b");
    expect([black.r, black.g, black.b].every((v) => Math.abs(v) < 1e-3)).toBe(true);
    // oklch(62.8% 0.2577 29.23) is sRGB red
    const red = resolveColor({ "--r": "oklch(62.8% 0.2577 29.23)" }, "--r");
    expect(red.r).toBeGreaterThan(0.99);
    expect(red.g).toBeLessThan(0.02);
  });

  it("refuses a colour it cannot read, rather than passing a check on nonsense", () => {
    expect(() => resolveColor({ "--x": "red" }, "--x")).toThrow(/oklch/);
    expect(() => resolveColor({}, "--missing")).toThrow(/missing/);
    expect(() => resolveColor({ "--x": "oklch(50% 0.1 var(--nope))" }, "--x")).toThrow(/--nope/);
  });
});
