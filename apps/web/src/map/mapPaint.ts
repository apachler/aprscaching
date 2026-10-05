// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Map paint from the design tokens. MapLibre's style paint takes hex/rgb strings and cannot read CSS custom
 * properties or OKLCH, so the map's own colours (the grid, rings, ruler, arc, night shade, tracks, the
 * offline graticule) are tokens in tokens.css, read here as #rrggbb at paint time and painted again whenever
 * the theme changes. The basemap style itself stays the same in every theme except Phosphor.
 */
import { useEffect, useState } from "react";
import type * as maplibregl from "maplibre-gl";
import { GRATICULE_PALETTE, type GridPalette } from "@aprscaching/shared";
import type { ResolvedTheme } from "../format.js";
import { tokenHex } from "../shell/tokenColor.js";

export { tokenHex };

function appliedTheme(): ResolvedTheme {
  const t = typeof document !== "undefined" ? document.documentElement.dataset.theme : undefined;
  return t === "light" || t === "phosphor" ? t : "dark";
}

/** The theme the token layer is showing (the root's data-theme), re-rendering when it changes. */
export function useAppliedTheme(): ResolvedTheme {
  const [theme, setTheme] = useState<ResolvedTheme>(appliedTheme);
  useEffect(() => {
    const html = document.documentElement;
    const obs = new MutationObserver(() => setTheme(appliedTheme()));
    obs.observe(html, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

/** Paint properties whose colour is a token: layer id → property → token name. */
export type TokenPaint = Record<string, Record<string, string>>;

/** Set each listed paint property of the layers that exist to its token's colour now. */
export function paintFromTokens(map: maplibregl.Map, paint: TokenPaint): void {
  for (const [layer, props] of Object.entries(paint)) {
    if (!map.getLayer(layer)) continue;
    for (const [prop, token] of Object.entries(props)) {
      map.setPaintProperty(layer, prop as Parameters<maplibregl.Map["setPaintProperty"]>[1], tokenHex(token));
    }
  }
}

/** The offline graticule's palette for the applied theme (the shared light palette's geometry and weights). */
export function graticulePalette(): GridPalette {
  return {
    ...GRATICULE_PALETTE,
    bg: tokenHex("--map-graticule-bg", GRATICULE_PALETTE.bg),
    line: tokenHex("--map-graticule-line", GRATICULE_PALETTE.line),
  };
}

/** Repaint the graticule's layers, when the graticule is the base on screen. */
export const GRATICULE_PAINT: TokenPaint = {
  ocean: { "background-color": "--map-graticule-bg" },
  "grid-minor": { "line-color": "--map-graticule-line" },
  "grid-major": { "line-color": "--map-graticule-line" },
  "grid-fine": { "line-color": "--map-graticule-line" },
};

/**
 * Run SETUP once the map's style is complete: now, or at the first moment it is. An overlay can mount long after
 * the map's one-time "load" (or while another overlay's new sources keep isStyleLoaded() false), so waiting for
 * "load" alone can wait for ever. Returns the cancel.
 */
export function whenStyleReady(map: maplibregl.Map, setup: () => void): () => void {
  if (map.isStyleLoaded()) {
    setup();
    return () => {};
  }
  const tryNow = () => {
    if (!map.isStyleLoaded()) return;
    map.off("styledata", tryNow);
    map.off("idle", tryNow);
    setup();
  };
  map.on("styledata", tryNow);
  map.on("idle", tryNow);
  return () => {
    map.off("styledata", tryNow);
    map.off("idle", tryNow);
  };
}
