import { useEffect, useRef, useState } from "react";
import type maplibregl from "maplibre-gl";
import { destinationPoint, haversineMeters, initialBearing } from "@aprsweb/aprs";
import { useFmt } from "../format.js";

/**
 * Map field-navigation tools (docs/11 M2): a Maidenhead/lat-lon grid overlay, concentric range rings
 * around the view centre, and a two-point ruler (distance + bearing). Pure client geo over the
 * existing MapLibre map — no tiles, no backend. Labels/readouts live in the DOM (no glyph dependency);
 * the map only draws compositor-cheap line/circle layers. Each tool is an independent toggle (ui-ux).
 */
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
const SRC = { grid: "mt-grid", rings: "mt-rings", rulerLine: "mt-ruler-line", rulerPts: "mt-ruler-pts" };

/** Pick a "nice" grid step (degrees) so ~4–8 lines span the view. */
function gridStep(spanDeg: number): number {
  const steps = [30, 10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.02, 0.01, 0.005];
  return steps.find((s) => s <= spanDeg / 4) ?? 0.005;
}
/** A "nice" ring base radius (m) near a target on-screen size. */
function niceRadius(target: number): number {
  const nice = [10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10000, 25000, 50000, 100000, 250000];
  return nice.find((n) => n >= target) ?? 500000;
}

function gridFC(b: maplibregl.LngLatBounds): GeoJSON.FeatureCollection {
  const w = b.getWest(), e = b.getEast(), s = b.getSouth(), n = b.getNorth();
  const step = gridStep(Math.max(e - w, n - s));
  const feats: GeoJSON.Feature[] = [];
  for (let lon = Math.ceil(w / step) * step; lon <= e; lon += step)
    feats.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[lon, s], [lon, n]] } });
  for (let lat = Math.ceil(s / step) * step; lat <= n; lat += step)
    feats.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[w, lat], [e, lat]] } });
  return { type: "FeatureCollection", features: feats };
}

function ringFC(lat: number, lon: number, radii: number[]): GeoJSON.FeatureCollection {
  const feats: GeoJSON.Feature[] = radii.map((r) => ({
    type: "Feature", properties: { r },
    geometry: { type: "LineString", coordinates: Array.from({ length: 65 }, (_, i) => {
      const p = destinationPoint(lat, lon, (i * 360) / 64, r); return [p.lon, p.lat] as [number, number];
    }) },
  }));
  return { type: "FeatureCollection", features: feats };
}

export function MapTools(props: { map: maplibregl.Map | null }) {
  const fmt = useFmt();
  const [grid, setGrid] = useState(false);
  const [rings, setRings] = useState(false);
  const [ruler, setRuler] = useState(false);
  const [radii, setRadii] = useState<number[]>([]);
  const [pts, setPts] = useState<[number, number][]>([]); // ruler points [lon,lat]

  const stateRef = useRef({ grid, rings, ruler });
  stateRef.current = { grid, rings, ruler };
  const ptsRef = useRef(pts); ptsRef.current = pts;

  const setData = (m: maplibregl.Map, id: string, data: GeoJSON.FeatureCollection) =>
    (m.getSource(id) as maplibregl.GeoJSONSource | undefined)?.setData(data);

  // one-time: add empty sources + cheap line/circle layers
  useEffect(() => {
    const m = props.map; if (!m) return;
    const setup = () => {
      for (const id of Object.values(SRC)) if (!m.getSource(id)) m.addSource(id, { type: "geojson", data: EMPTY });
      if (!m.getLayer("mt-grid-l")) m.addLayer({ id: "mt-grid-l", type: "line", source: SRC.grid, paint: { "line-color": "#6f97ad", "line-width": 0.6, "line-opacity": 0.45 } });
      if (!m.getLayer("mt-rings-l")) m.addLayer({ id: "mt-rings-l", type: "line", source: SRC.rings, paint: { "line-color": "#2D8BAB", "line-width": 1.1, "line-opacity": 0.7, "line-dasharray": [2, 2] } });
      if (!m.getLayer("mt-ruler-l")) m.addLayer({ id: "mt-ruler-l", type: "line", source: SRC.rulerLine, paint: { "line-color": "#e5532d", "line-width": 2 } });
      if (!m.getLayer("mt-ruler-p")) m.addLayer({ id: "mt-ruler-p", type: "circle", source: SRC.rulerPts, paint: { "circle-radius": 4, "circle-color": "#e5532d", "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
    };
    if (m.isStyleLoaded()) setup(); else m.once("load", setup);
  }, [props.map]);

  // grid + rings recompute on view move (and when toggled)
  useEffect(() => {
    const m = props.map; if (!m) return;
    const redraw = () => {
      if (!m.isStyleLoaded()) return;
      setData(m, SRC.grid, stateRef.current.grid ? gridFC(m.getBounds()) : EMPTY);
      if (stateRef.current.rings) {
        const c = m.getCenter();
        const mpp = (156543.03392 * Math.cos((c.lat * Math.PI) / 180)) / 2 ** m.getZoom();
        const base = niceRadius(mpp * 70);
        const rs = [base, base * 2, base * 3, base * 4];
        setRadii(rs); setData(m, SRC.rings, ringFC(c.lat, c.lng, rs));
      } else { setRadii([]); setData(m, SRC.rings, EMPTY); }
    };
    redraw();
    m.on("moveend", redraw);
    return () => { m.off("moveend", redraw); };
  }, [props.map, grid, rings]);

  // ruler: click to drop up to two points
  useEffect(() => {
    const m = props.map; if (!m) return;
    const onClick = (e: maplibregl.MapMouseEvent) => {
      if (!stateRef.current.ruler) return;
      const next = ptsRef.current.length >= 2 ? [[e.lngLat.lng, e.lngLat.lat]] as [number, number][]
        : [...ptsRef.current, [e.lngLat.lng, e.lngLat.lat] as [number, number]];
      setPts(next);
      setData(m, SRC.rulerPts, { type: "FeatureCollection", features: next.map((p) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: p } })) });
      setData(m, SRC.rulerLine, next.length === 2 ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: next } }] } : EMPTY);
    };
    if (ruler) { m.getCanvas().style.cursor = "crosshair"; m.on("click", onClick); }
    return () => { m.off("click", onClick); if (m.getCanvas()) m.getCanvas().style.cursor = ""; };
  }, [props.map, ruler]);

  function clearRuler() {
    const m = props.map; setPts([]);
    if (m) { setData(m, SRC.rulerLine, EMPTY); setData(m, SRC.rulerPts, EMPTY); }
  }

  if (!props.map) return null;
  const measure = pts.length === 2
    ? { d: haversineMeters(pts[0]![1], pts[0]![0], pts[1]![1], pts[1]![0]), b: initialBearing(pts[0]![1], pts[0]![0], pts[1]![1], pts[1]![0]) }
    : null;

  return (
    <div className="maptools">
      <div className="maptools-bar" role="group" aria-label="Map tools">
        <button className={grid ? "on" : ""} aria-pressed={grid} title="Grid overlay" onClick={() => setGrid((v) => !v)}>▦</button>
        <button className={rings ? "on" : ""} aria-pressed={rings} title="Range rings" onClick={() => setRings((v) => !v)}>◎</button>
        <button className={ruler ? "on" : ""} aria-pressed={ruler} title="Ruler (distance + bearing)" onClick={() => { setRuler((v) => !v); if (ruler) clearRuler(); }}>📏</button>
      </div>
      {rings && radii.length > 0 && (
        <div className="maptools-legend">rings: {radii.map((r) => fmt.distance(r)).join(" · ")}</div>
      )}
      {ruler && (
        <div className="maptools-legend">
          {measure ? <><strong>{fmt.distance(measure.d)}</strong> · {measure.b.toFixed(0)}°{pts.length === 2 && <button className="link" onClick={clearRuler}>clear</button>}</>
            : `tap two points… (${pts.length}/2)`}
        </div>
      )}
    </div>
  );
}
