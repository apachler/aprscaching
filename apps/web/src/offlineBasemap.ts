import type { StyleSpecification } from "maplibre-gl";
import { BRAND } from "./brand.js";

/**
 * A fully self-contained MapLibre style: a tinted ocean + a lat/lon graticule, with
 * whole-degree lines emphasised. No network/tiles required — handy for air-gapped/field
 * use and for deterministic rendering. Evokes the classic APRS world-grid identity.
 */
export function buildGraticuleStyle(stepDeg = 0.1): StyleSpecification {
  const minor: GeoJSON.Feature[] = [];
  const major: GeoJSON.Feature[] = [];
  const line = (coords: [number, number][]): GeoJSON.Feature => ({
    type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords },
  });
  const round = (n: number) => Math.round(n * 1000) / 1000;

  for (let lon = -180; lon <= 180; lon += stepDeg) {
    const f = line([[lon, -85], [lon, 85]]);
    (round(lon) % 1 === 0 ? major : minor).push(f);
  }
  for (let lat = -85; lat <= 85; lat += stepDeg) {
    const f = line([[-180, lat], [180, lat]]);
    (round(lat) % 1 === 0 ? major : minor).push(f);
  }
  const fc = (feats: GeoJSON.Feature[]): GeoJSON.FeatureCollection =>
    ({ type: "FeatureCollection", features: feats });

  return {
    version: 8,
    sources: {
      grid_minor: { type: "geojson", data: fc(minor) },
      grid_major: { type: "geojson", data: fc(major) },
    },
    layers: [
      { id: "ocean", type: "background", paint: { "background-color": "#e9f2f6" } },
      { id: "grid-minor", type: "line", source: "grid_minor",
        paint: { "line-color": BRAND.blue, "line-opacity": 0.22, "line-width": 0.7 } },
      { id: "grid-major", type: "line", source: "grid_major",
        paint: { "line-color": BRAND.blue, "line-opacity": 0.55, "line-width": 1.3 } },
    ],
  } as StyleSpecification;
}
