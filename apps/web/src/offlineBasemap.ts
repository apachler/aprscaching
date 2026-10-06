// SPDX-License-Identifier: AGPL-3.0-or-later
// maplibre-gl does not declare the ambient GeoJSON namespace; import it explicitly.
import type * as GeoJSON from "geojson";
import type { StyleSpecification } from "maplibre-gl";
import type { GridPalette } from "@aprscaching/shared";
import { graticulePalette } from "./map/mapPaint.js";

/** The graticule's close-up grid source, filled for the view by {@link fineGridLines}. */
export const FINE_GRID_SOURCE = "grid_fine";
/** From this zoom the 0.1° grid leaves the view between its lines, so the close-up grid takes over. */
const FINE_GRID_MINZOOM = 11;

/**
 * The close-up grid for a view: lines every 0.01° from zoom 11 and every 0.001° from zoom 15, only across the view
 * (one step beyond each edge), so a street-level map still shows its grid. Below zoom 11 it is empty: the 0.1° and
 * whole-degree lines carry the view. Pure.
 */
export function fineGridLines(
  view: { west: number; south: number; east: number; north: number },
  zoom: number,
): GeoJSON.FeatureCollection {
  const empty: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
  if (zoom < FINE_GRID_MINZOOM) return empty;
  const step = zoom >= 15 ? 0.001 : 0.01;
  const lo = (v: number) => Math.floor(v / step) - 1;
  const hi = (v: number) => Math.ceil(v / step) + 1;
  const [x0, x1, y0, y1] = [lo(view.west), hi(view.east), lo(Math.max(view.south, -85)), hi(Math.min(view.north, 85))];
  // a view far wider than the zoom suggests (a tilted map) would ask for thousands: draw none rather than stall
  if (x1 - x0 > 400 || y1 - y0 > 400) return empty;
  const fix = (n: number) => Math.round(n * step * 1e6) / 1e6;
  const features: GeoJSON.Feature[] = [];
  const line = (coords: [number, number][]): GeoJSON.Feature => ({
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: coords },
  });
  for (let i = x0; i <= x1; i++)
    features.push(
      line([
        [fix(i), fix(y0)],
        [fix(i), fix(y1)],
      ]),
    );
  for (let j = y0; j <= y1; j++)
    features.push(
      line([
        [fix(x0), fix(j)],
        [fix(x1), fix(j)],
      ]),
    );
  return { type: "FeatureCollection", features };
}

/** The shared lat/lon graticule geometry + layers, recoloured per palette. Fully self-contained
 *  (no network/tiles) — for air-gapped/field use and deterministic rendering. */
function graticule(pal: GridPalette, stepDeg: number): StyleSpecification {
  const minor: GeoJSON.Feature[] = [];
  const major: GeoJSON.Feature[] = [];
  const line = (coords: [number, number][]): GeoJSON.Feature => ({
    type: "Feature",
    properties: {},
    geometry: { type: "LineString", coordinates: coords },
  });
  const round = (n: number) => Math.round(n * 1000) / 1000;

  for (let lon = -180; lon <= 180; lon += stepDeg) {
    const f = line([
      [lon, -85],
      [lon, 85],
    ]);
    (round(lon) % 1 === 0 ? major : minor).push(f);
  }
  for (let lat = -85; lat <= 85; lat += stepDeg) {
    const f = line([
      [-180, lat],
      [180, lat],
    ]);
    (round(lat) % 1 === 0 ? major : minor).push(f);
  }
  const fc = (feats: GeoJSON.Feature[]): GeoJSON.FeatureCollection => ({ type: "FeatureCollection", features: feats });

  return {
    version: 8,
    sources: {
      grid_minor: { type: "geojson", data: fc(minor) },
      grid_major: { type: "geojson", data: fc(major) },
      // the close-up grid, drawn for the view alone as it moves (map/fineGrid.ts): a world of it would not fit
      [FINE_GRID_SOURCE]: { type: "geojson", data: fc([]) },
    },
    layers: [
      { id: "ocean", type: "background", paint: { "background-color": pal.bg } },
      {
        id: "grid-fine",
        type: "line",
        source: FINE_GRID_SOURCE,
        minzoom: FINE_GRID_MINZOOM,
        paint: { "line-color": pal.line, "line-opacity": pal.minorOp, "line-width": pal.minorW },
      },
      {
        id: "grid-minor",
        type: "line",
        source: "grid_minor",
        paint: { "line-color": pal.line, "line-opacity": pal.minorOp, "line-width": pal.minorW },
      },
      {
        id: "grid-major",
        type: "line",
        source: "grid_major",
        paint: {
          "line-color": pal.line,
          "line-opacity": pal.majorOp,
          "line-width": pal.majorW,
          "line-blur": pal.glow ?? 0,
        },
      },
    ],
  } as StyleSpecification;
}

/** Tinted ocean + blue world-grid — the classic APRS identity, offline and keyless. Its colours are the
 *  applied theme's `--map-graticule-*` tokens: a dark sea in Dark, a light one in Light. */
export function buildGraticuleStyle(stepDeg = 0.1): StyleSpecification {
  return graticule(graticulePalette(), stepDeg);
}

/** The Phosphor map: near-black phosphor field + a dim green grid, glowing on the whole
 *  degrees. Keyless/offline like the graticule so the map matches the terminal chrome everywhere. */
export function buildPhosphorStyle(stepDeg = 0.1): StyleSpecification {
  return graticule(
    { bg: "#0b130e", line: "#41ffa0", minorOp: 0.16, majorOp: 0.6, minorW: 0.7, majorW: 1.4, glow: 0.8 },
    stepDeg,
  );
}

/**
 * The offline packs' map: the vector tiles of the operator's archive (the Protomaps basemap schema — earth,
 * landcover, landuse, water, roads, buildings, boundaries), drawn from the packs through `acs-pack://`.
 * It carries no labels, since text needs font files that a pack does not hold; the caches, the grid square
 * readout and the distance to a cache carry the navigation. Literal colours, as in any MapLibre style.
 */
export function buildPackTileStyle(maxZoom: number, attribution: string): StyleSpecification {
  const src = "packs";
  const fill = (id: string, layer: string, color: string, filter?: unknown) => ({
    id,
    type: "fill",
    source: src,
    "source-layer": layer,
    ...(filter ? { filter } : {}),
    paint: { "fill-color": color },
  });
  const road = (id: string, kinds: string[], color: string, width: [number, number]) => ({
    id,
    type: "line",
    source: src,
    "source-layer": "roads",
    filter: ["in", ["get", "kind"], ["literal", kinds]],
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": color,
      "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 8, width[0], 16, width[1]],
    },
  });
  return {
    version: 8,
    sources: {
      [src]: { type: "vector", tiles: ["acs-pack://{z}/{x}/{y}"], minzoom: 0, maxzoom: maxZoom, attribution },
    },
    layers: [
      { id: "sea", type: "background", paint: { "background-color": "#cfe3ec" } },
      fill("earth", "earth", "#f2efe9"),
      fill("landcover-forest", "landcover", "#d6e8cf", ["in", ["get", "kind"], ["literal", ["forest", "wood"]]]),
      fill("landcover-grass", "landcover", "#e4edd3", [
        "in",
        ["get", "kind"],
        ["literal", ["grassland", "scrub", "farmland"]],
      ]),
      fill("landcover-ice", "landcover", "#f7fbfc", ["in", ["get", "kind"], ["literal", ["glacier", "barren"]]]),
      fill("landuse-park", "landuse", "#d9ead0", [
        "in",
        ["get", "kind"],
        ["literal", ["park", "nature_reserve", "forest", "wood"]],
      ]),
      fill("landuse-built", "landuse", "#ebe6df", [
        "in",
        ["get", "kind"],
        ["literal", ["residential", "industrial", "commercial"]],
      ]),
      fill("water", "water", "#a9cde0"),
      {
        id: "boundaries",
        type: "line",
        source: src,
        "source-layer": "boundaries",
        paint: { "line-color": "#9a8fa6", "line-width": 1, "line-dasharray": [3, 2] },
      },
      road("roads-path", ["path"], "#b9a98f", [0.4, 1.4]),
      road("roads-minor", ["minor_road", "other"], "#ffffff", [0.4, 4]),
      road("roads-major", ["major_road"], "#fbe2a6", [0.8, 6]),
      road("roads-highway", ["highway"], "#f4b878", [1, 8]),
      {
        id: "buildings",
        type: "fill",
        source: src,
        "source-layer": "buildings",
        minzoom: 14,
        paint: { "fill-color": "#ddd6cc", "fill-outline-color": "#c9c0b4" },
      },
    ],
  } as StyleSpecification;
}
