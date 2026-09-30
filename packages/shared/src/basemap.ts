// SPDX-License-Identifier: MIT
/**
 * The map pieces the web app and the gateway's embeddable widget share: the default basemap, the
 * self-contained grid palette, and where the web build publishes its copy of MapLibre. This module
 * imports nothing, so the web app's Vite config can load it directly.
 */

/** The online basemap used unless an instance names another: OpenFreeMap's keyless OSM vector style. */
export const DEFAULT_BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";

/** Palette of the self-contained lat/lon grid basemap. MapLibre paints into the GPU canvas and cannot
 *  read CSS tokens, so these are literal colours, like any MapLibre style JSON. */
export interface GridPalette {
  bg: string;
  line: string;
  minorOp: number;
  majorOp: number;
  minorW: number;
  majorW: number;
  glow?: number;
}

/** The offline grid: a tinted ocean under the brand-blue world grid, the classic APRS look. */
export const GRATICULE_PALETTE: GridPalette = {
  bg: "#e9f2f6",
  line: "#2D8BAB",
  minorOp: 0.22,
  majorOp: 0.55,
  minorW: 0.7,
  majorW: 1.3,
};

/** MapLibre's major version. The embed widget is written against this API; the web build refuses to
 *  build when the installed maplibre-gl has another major, so the two never drift apart. */
export const MAPLIBRE_MAJOR = 6;

/**
 * Where the web build publishes MapLibre for the embed widget, relative to the app origin. The files are
 * `maplibre-gl.js` (the module entry), `maplibre-gl-shared.js` (its chunk), `maplibre-gl-worker.js`
 * (the worker) and `maplibre-gl.css`. The path carries the major version, so an instance's embeds keep
 * a stable URL across minor updates while a breaking MapLibre release gets a new one.
 */
export const MAPLIBRE_VENDOR_DIR = `vendor/maplibre-gl/${MAPLIBRE_MAJOR}`;
