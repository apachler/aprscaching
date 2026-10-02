// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A design token as a plain colour, for the places that cannot read CSS custom properties or OKLCH: MapLibre
 * paint, Mermaid and the browser's theme-color meta. The browser resolves the token (var(), OKLCH, color-mix);
 * cssColorToHex turns what getComputedStyle reports into #rrggbb.
 */

const clamp = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
const hex = (rgb: number[]) => `#${rgb.map((v) => clamp(v).toString(16).padStart(2, "0")).join("")}`;
const gamma = (x: number) => 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
/** A number, a percentage of SCALE, or `none` (0). */
const num = (s: string, scale = 1) =>
  s === "none" ? 0 : s.endsWith("%") ? (parseFloat(s) / 100) * scale : parseFloat(s);

function oklabToRgb(l: number, a: number, b: number): number[] {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ].map(gamma);
}

/**
 * A computed CSS colour as #rrggbb, or null for a form it does not read. Browsers report a resolved colour in
 * different forms (Chromium `color(srgb …)` or `rgb()`, Firefox and Safari `oklab()` or `oklch()`), and a canvas
 * does not parse all of them everywhere, so the common forms are converted here; alpha is dropped.
 */
export function cssColorToHex(css: string): string | null {
  const m = /^\s*([a-z]+)\(\s*([^)]*)\)\s*$/i.exec(css);
  if (!m) return /^#[0-9a-f]{6}$/i.test(css.trim()) ? css.trim().toLowerCase() : null;
  const fn = m[1]!.toLowerCase();
  const parts = m[2]!.split(/[\s,/]+/).filter(Boolean);
  if (fn === "rgb" || fn === "rgba") return parts.length >= 3 ? hex(parts.slice(0, 3).map((p) => num(p, 255))) : null;
  if (fn === "color") {
    const space = parts[0]?.toLowerCase();
    const v = parts.slice(1, 4).map((p) => num(p));
    if (v.length < 3 || v.some(Number.isNaN)) return null;
    if (space === "srgb") return hex(v.map((x) => x * 255));
    if (space === "srgb-linear") return hex(v.map(gamma));
    return null;
  }
  if (fn === "oklab" && parts.length >= 3)
    return hex(oklabToRgb(num(parts[0]!), num(parts[1]!, 0.4), num(parts[2]!, 0.4)));
  if (fn === "oklch" && parts.length >= 3) {
    const c = num(parts[1]!, 0.4);
    const h = (num(parts[2]!) * Math.PI) / 180;
    return hex(oklabToRgb(num(parts[0]!), c * Math.cos(h), c * Math.sin(h)));
  }
  return null;
}

/** A colour token of the applied theme as #rrggbb; FALLBACK when the page cannot say. */
export function tokenHex(name: string, fallback = "#808080"): string {
  try {
    if (typeof document === "undefined" || !document.body) return fallback;
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const css = getComputedStyle(probe).color;
    probe.remove();
    if (!css) return fallback;
    const parsed = cssColorToHex(css);
    if (parsed) return parsed;
    // any other form: let a 1×1 canvas resolve it
    const c = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (!c) return fallback;
    c.fillStyle = css;
    c.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = c.getImageData(0, 0, 1, 1).data;
    return hex([r, g, b]);
  } catch {
    return fallback;
  }
}
