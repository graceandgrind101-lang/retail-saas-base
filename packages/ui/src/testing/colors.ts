/**
 * Colour maths for the contrast tests. Test-only: nothing here ships to the browser.
 * OKLCH to sRGB follows Björn Ottosson's OKLab definition; contrast is WCAG 2.x relative luminance.
 */
export interface Rgb {
  /** 0 to 1, gamma-encoded sRGB, clipped to the sRGB gamut. */
  r: number;
  g: number;
  b: number;
}

/** `--name: value;` declarations inside the block that starts with `selector {`. */
export function parseTokens(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`no block for ${selector}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("\n}", open);
  const body = css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Record<string, string> = {};
  for (const match of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[match[1] as string] = (match[2] as string).trim();
  return out;
}

function substitute(tokens: Record<string, string>, value: string, depth = 0): string {
  if (depth > 8) throw new Error("variable loop");
  return value.replace(/var\((--[a-z0-9-]+)\)/g, (_all, name: string) => {
    const inner = tokens[name];
    if (inner === undefined) throw new Error(`unknown variable ${name}`);
    return substitute(tokens, inner, depth + 1);
  });
}

const srgbEncode = (linear: number): number => {
  const v = Math.min(1, Math.max(0, linear));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
};

export function resolveColor(tokens: Record<string, string>, name: string): Rgb {
  const raw = tokens[name];
  if (raw === undefined) throw new Error(`token ${name} is missing`);
  const value = substitute(tokens, raw);
  const match = /^oklch\(\s*([0-9.]+)%\s+([0-9.]+)\s+([0-9.]+)\s*(?:\/\s*[0-9.]+)?\s*\)$/.exec(value);
  if (!match) throw new Error(`${name}: expected oklch(L% C H), got "${value}"`);
  const L = Number(match[1]) / 100;
  const C = Number(match[2]);
  const h = (Number(match[3]) * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: srgbEncode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: srgbEncode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: srgbEncode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

const linearize = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

export function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** WCAG contrast ratio, 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
