// SPDX-License-Identifier: AGPL-3.0-or-later
import type { StyleSpecification } from "maplibre-gl";
import { BRAND } from "./brand.js";

/** Palette for a graticule style. MapLibre paints into the GPU canvas and can't read CSS tokens, so
 *  these are literal colours (like any MapLibre style JSON) — the theme picks which builder to use. */
interface GridPalette {
  bg: string;
  line: string;
  minorOp: number;
  majorOp: number;
  minorW: number;
  majorW: number;
  glow?: number;
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
    },
    layers: [
      { id: "ocean", type: "background", paint: { "background-color": pal.bg } },
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

/** Tinted ocean + blue world-grid — the classic APRS identity (Modern theme / offline). */
export function buildGraticuleStyle(stepDeg = 0.1): StyleSpecification {
  return graticule(
    { bg: "#e9f2f6", line: BRAND.blue, minorOp: 0.22, majorOp: 0.55, minorW: 0.7, majorW: 1.3 },
    stepDeg,
  );
}

/** The Cogmind map: near-black phosphor field + a dim green grid, glowing on the whole
 *  degrees. Keyless/offline like the graticule so the map matches the terminal chrome everywhere. */
export function buildCogmindStyle(stepDeg = 0.1): StyleSpecification {
  return graticule(
    { bg: "#0b130e", line: "#41ffa0", minorOp: 0.16, majorOp: 0.6, minorW: 0.7, majorW: 1.4, glow: 0.8 },
    stepDeg,
  );
}
