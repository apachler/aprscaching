// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A design token as a plain colour, for the places that cannot read CSS custom properties or OKLCH: MapLibre
 * paint and the browser's theme-color meta. The browser resolves the token (var(), OKLCH, color-mix) and a
 * 1×1 canvas turns the result into #rrggbb.
 */
/** A colour token of the applied theme as #rrggbb, through a 1×1 canvas; FALLBACK when the page cannot say. */
export function tokenHex(name: string, fallback = "#808080"): string {
  try {
    if (typeof document === "undefined" || !document.body) return fallback;
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const css = getComputedStyle(probe).color;
    probe.remove();
    const c = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    if (!c || !css) return fallback;
    c.fillStyle = css;
    c.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0] = c.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return fallback;
  }
}
