// SPDX-License-Identifier: AGPL-3.0-or-later
// The design tokens as numbers: reads apps/web/src/styles/tokens.css, resolves a theme's custom properties
// (var() chains, oklch(), hex, color-mix() in oklch or oklab, transparent) to sRGB, and measures WCAG contrast. Used by
// the contrast test; it implements just the colour syntax tokens.css uses and throws on anything else, so a new
// syntax fails loudly instead of being measured wrong.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type Theme = "dark" | "light" | "phosphor";
/** sRGB, gamma-encoded, 0–1, with alpha. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}
interface Oklch {
  l: number;
  c: number;
  h: number | null; // null = "none" (achromatic: takes the other colour's hue in a mix)
  a: number;
}

const TOKENS = join(dirname(fileURLToPath(import.meta.url)), "../../src/styles/tokens.css");

/** The declarations of every rule block in tokens.css, keyed by selector, in file order. */
function blocks(css: string): { selector: string; decls: Map<string, string> }[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { selector: string; decls: Map<string, string> }[] = [];
  const re = /([^{};]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const selector = m[1].trim();
    const decls = new Map<string, string>();
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) decls.set(d[1], d[2].replace(/\s+/g, " ").trim());
    out.push({ selector, decls });
  }
  return out;
}

/** The custom properties in effect for THEME: :root, then the theme's own block over it. */
export function themeTokens(theme: Theme, css = readFileSync(TOKENS, "utf8")): Map<string, string> {
  const map = new Map<string, string>();
  for (const b of blocks(css)) {
    if (b.selector === ":root" || b.selector === `:root[data-theme="${theme}"]`)
      for (const [k, v] of b.decls) map.set(k, v);
  }
  return map;
}

function splitTop(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  parts.push(cur.trim());
  return parts;
}

function num(s: string): number {
  const v = s.endsWith("%") ? parseFloat(s) / 100 : parseFloat(s);
  if (Number.isNaN(v)) throw new Error(`not a number: ${s}`);
  return v;
}

/** Parse one colour value, resolving var() through TOKENS. */
export function parseColor(value: string, tokens: Map<string, string>, seen: string[] = []): Oklch {
  const v = value.trim();
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref) {
    if (seen.includes(ref[1])) throw new Error(`var() cycle: ${[...seen, ref[1]].join(" → ")}`);
    const t = tokens.get(ref[1]);
    if (t === undefined) throw new Error(`unknown token ${ref[1]}`);
    return parseColor(t, tokens, [...seen, ref[1]]);
  }
  if (v === "transparent") return { l: 0, c: 0, h: null, a: 0 };
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) return srgbToOklch(fromHex(hex[1]));
  const ok = /^oklch\(\s*([^)]*)\)$/.exec(v);
  if (ok) {
    const [main, alpha] = ok[1].split("/").map((s) => s.trim());
    const [l, c, h] = main.split(/\s+/);
    return { l: num(l), c: num(c), h: h === "none" ? null : num(h), a: alpha ? num(alpha) : 1 };
  }
  const mix = /^color-mix\(\s*in (oklch|oklab)\s*,(.*)\)$/.exec(v);
  if (mix) {
    // a percentage may itself be a token: color-mix(in oklch, var(--tc) var(--hue-text), var(--ink))
    const body = (mix[2] ?? "").replace(/var\((--[\w-]+)\)/g, (m, name: string) => {
      const t = tokens.get(name);
      return t !== undefined && /^\d+(\.\d+)?%$/.test(t) ? t : m;
    });
    const [p1, p2] = splitTop(body);
    const part = (p: string) => {
      const pm = /^(.*?)\s+(\d+(?:\.\d+)?)%$/.exec(p);
      return pm ? { col: pm[1], pct: parseFloat(pm[2]) / 100 } : { col: p, pct: null as number | null };
    };
    const a = part(p1);
    const b = part(p2);
    const wa = a.pct ?? (b.pct !== null ? 1 - b.pct : 0.5);
    const mixer = mix[1] === "oklab" ? mixOklab : mixOklch;
    return mixer(parseColor(a.col, tokens, seen), parseColor(b.col, tokens, seen), wa);
  }
  throw new Error(`unsupported colour syntax: ${v}`);
}

/** color-mix(in oklch, A wa, B): premultiplied alpha, shorter hue arc, "none" takes the other hue. */
function mixOklch(a: Oklch, b: Oklch, wa: number): Oklch {
  const wb = 1 - wa;
  const alpha = a.a * wa + b.a * wb;
  if (alpha === 0) return { l: 0, c: 0, h: null, a: 0 };
  const pm = (x: number, y: number) => (x * a.a * wa + y * b.a * wb) / alpha;
  let h: number | null;
  if (a.h === null && b.h === null) h = null;
  else if (a.h === null) h = b.h;
  else if (b.h === null) h = a.h;
  else {
    let d = b.h - a.h;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    h = (a.h + d * wb + 360) % 360;
  }
  // a fully transparent partner (transparent = oklch(0 0 none / 0)) contributes no colour
  return { l: pm(a.l, b.l), c: pm(a.c, b.c), h, a: alpha };
}

/** color-mix(in oklab, A wa, B): premultiplied alpha, straight through the a/b plane (no hue arc). */
function mixOklab(a: Oklch, b: Oklch, wa: number): Oklch {
  const wb = 1 - wa;
  const alpha = a.a * wa + b.a * wb;
  if (alpha === 0) return { l: 0, c: 0, h: null, a: 0 };
  const lab = (x: Oklch) => {
    const hr = ((x.h ?? 0) * Math.PI) / 180;
    return { l: x.l, A: x.c * Math.cos(hr), B: x.c * Math.sin(hr) };
  };
  const p = lab(a);
  const q = lab(b);
  const pm = (x: number, y: number) => (x * a.a * wa + y * b.a * wb) / alpha;
  const A = pm(p.A, q.A);
  const B = pm(p.B, q.B);
  const c = Math.hypot(A, B);
  return { l: pm(p.l, q.l), c, h: c < 1e-6 ? null : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360, a: alpha };
}

function fromHex(h: string): Rgba {
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
    a: 1,
  };
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp = (x: number) => Math.min(1, Math.max(0, x));

export function oklchToRgb(c: Oklch): Rgba {
  const hr = ((c.h ?? 0) * Math.PI) / 180;
  const A = c.c * Math.cos(hr);
  const B = c.c * Math.sin(hr);
  const l_ = c.l + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = c.l - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = c.l - 0.0894841775 * A - 1.291485548 * B;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return {
    r: clamp(toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    g: clamp(toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    b: clamp(toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
    a: c.a,
  };
}

function srgbToOklch(c: Rgba): Oklch {
  const r = toLinear(c.r);
  const g = toLinear(c.g);
  const b = toLinear(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363015253 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(A, B);
  return { l: L, c: C, h: C < 1e-6 ? null : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360, a: c.a };
}

/** FG over BG (both may be translucent; BG is composited over OVER first), as the browser paints it. */
function over(fg: Rgba, bg: Rgba): Rgba {
  const a = fg.a + bg.a * (1 - fg.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const ch = (x: number, y: number) => (x * fg.a + y * bg.a * (1 - fg.a)) / a;
  return { r: ch(fg.r, bg.r), g: ch(fg.g, bg.g), b: ch(fg.b, bg.b), a };
}

const luminance = (c: Rgba) => 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);

/** WCAG 2 contrast ratio of FG on BG, BG laid over BEHIND (an opaque colour) when it is translucent. */
export function contrast(theme: Theme, fg: string, bg: string, behind = "var(--surface)", css?: string): number {
  const t = themeTokens(theme, css);
  const base = oklchToRgb(parseColor(behind, t));
  if (base.a < 1) throw new Error(`the colour behind (${behind}) must be opaque in ${theme}`);
  const back = over(oklchToRgb(parseColor(bg, t)), base);
  const front = over(oklchToRgb(parseColor(fg, t)), back);
  const [hi, lo] = [luminance(front), luminance(back)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
