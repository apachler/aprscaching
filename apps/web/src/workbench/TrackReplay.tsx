import { useEffect, useRef, useState } from "react";
import type maplibregl from "maplibre-gl";
import { getStationTrack, type StationTrackPoint } from "../api.js";
import { useFmt } from "../format.js";

/**
 * Track history + time-replay (docs/11 M3). Browse a station's / living-cache's past positions by
 * date window, drawn as a polyline with each fix coloured by how it was heard — and scrub/play the
 * track. This doubles as a trust visualization: RF-heard fixes (green) vs IS-only (grey) make the
 * corroboration that powers Tier A visible. Pure client geo over the existing map (cheap line/circle
 * layers, labels in the DOM). Playback is discrete position updates (no CSS animation) and fit-bounds
 * is instant under reduced-motion — css.md compliant.
 */
const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
const SRC = { line: "trk-line", pts: "trk-pts", head: "trk-head" };

// colour each fix by trust source: RF-corroborable (green) · app-geo (blue) · IS-only (grey)
const VIA_COLOR: maplibregl.ExpressionSpecification = [
  "match", ["get", "via"], "rf", "#36b36b", "app", "#5b9dff", /* default */ "#8aa0b4",
];

const WINDOWS = [{ d: 1, label: "24h" }, { d: 7, label: "7d" }, { d: 30, label: "30d" }];

function reducedMotion(): boolean {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

export function TrackReplay(props: { map: maplibregl.Map | null; callsign: string }) {
  const fmt = useFmt();
  const [days, setDays] = useState(1);
  const [day, setDay] = useState("");                 // optional specific date (YYYY-MM-DD)
  const [pts, setPts] = useState<StationTrackPoint[]>([]);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [fps, setFps] = useState(8);                  // fixes advanced per second
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const acRef = useRef<AbortController | null>(null);

  const setData = (id: string, data: GeoJSON.FeatureCollection) =>
    (props.map?.getSource(id) as maplibregl.GeoJSONSource | undefined)?.setData(data);

  // one-time: add empty sources + cheap line/circle layers; remove them when this view goes away
  useEffect(() => {
    const m = props.map; if (!m) return;
    const setup = () => {
      for (const id of Object.values(SRC)) if (!m.getSource(id)) m.addSource(id, { type: "geojson", data: EMPTY });
      if (!m.getLayer("trk-line-l")) m.addLayer({ id: "trk-line-l", type: "line", source: SRC.line, paint: { "line-color": "#2D8BAB", "line-width": 2, "line-opacity": 0.7 } });
      if (!m.getLayer("trk-pts-l")) m.addLayer({ id: "trk-pts-l", type: "circle", source: SRC.pts, paint: { "circle-radius": 3, "circle-color": VIA_COLOR, "circle-opacity": 0.85 } });
      if (!m.getLayer("trk-head-l")) m.addLayer({ id: "trk-head-l", type: "circle", source: SRC.head, paint: { "circle-radius": 7, "circle-color": "#fff", "circle-stroke-color": "#e5532d", "circle-stroke-width": 3 } });
    };
    if (m.isStyleLoaded()) setup(); else m.once("load", setup);
    return () => {
      for (const l of ["trk-line-l", "trk-pts-l", "trk-head-l"]) if (m.getLayer(l)) m.removeLayer(l);
      for (const id of Object.values(SRC)) if (m.getSource(id)) m.removeSource(id);
    };
  }, [props.map]);

  // reset everything when the inspected station changes
  useEffect(() => {
    setPts([]); setIdx(0); setPlaying(false); setErr(null);
    setData(SRC.line, EMPTY); setData(SRC.pts, EMPTY); setData(SRC.head, EMPTY);
  }, [props.callsign]); // eslint-disable-line react-hooks/exhaustive-deps

  function drawHead(p: StationTrackPoint[], i: number) {
    const h = p[Math.min(Math.max(i, 0), p.length - 1)];
    setData(SRC.head, h ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [h.lon, h.lat] } }] } : EMPTY);
  }

  async function load() {
    if (!props.map) return;
    setLoading(true); setErr(null); setPlaying(false);
    acRef.current?.abort();
    const ac = new AbortController(); acRef.current = ac;
    try {
      let from: number, to: number;
      if (day) { from = Date.parse(`${day}T00:00:00Z`) / 1000; to = from + 86400; }
      else { to = Date.now() / 1000; from = to - days * 86400; }
      const r = await getStationTrack(props.callsign, from, to, ac.signal);
      const p = r.positions;
      setPts(p); setIdx(Math.max(0, p.length - 1));
      setData(SRC.line, p.length ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: p.map((x) => [x.lon, x.lat]) } }] } : EMPTY);
      setData(SRC.pts, { type: "FeatureCollection", features: p.map((x) => ({ type: "Feature", properties: { via: x.heardVia }, geometry: { type: "Point", coordinates: [x.lon, x.lat] } })) });
      drawHead(p, p.length - 1);
      if (p.length) {
        const lons = p.map((x) => x.lon), lats = p.map((x) => x.lat);
        props.map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
          { padding: 56, maxZoom: 15, duration: reducedMotion() ? 0 : 600 });
      }
    } catch (e) { if ((e as Error).name !== "AbortError") setErr((e as Error).message); }
    finally { setLoading(false); }
  }

  // move the playhead whenever the index changes
  useEffect(() => { if (pts.length) drawHead(pts, idx); }, [idx]); // eslint-disable-line react-hooks/exhaustive-deps

  // playback ticker — discrete steps (reduced-motion safe: no tweening, no CSS animation)
  useEffect(() => {
    if (!playing || pts.length < 2) return;
    const t = window.setInterval(() => {
      setIdx((i) => { if (i >= pts.length - 1) return i; return i + 1; });
    }, Math.max(1000 / fps, 16));
    return () => clearInterval(t);
  }, [playing, fps, pts.length]);

  // auto-stop at the end
  useEffect(() => { if (playing && pts.length && idx >= pts.length - 1) setPlaying(false); }, [idx, playing, pts.length]);

  const cur = pts[idx];
  return (
    <div className="trackreplay">
      <div className="tr-head">Track history</div>
      <div className="tr-controls">
        <div className="seg" role="group" aria-label="Window">
          {WINDOWS.map((w) => (
            <button key={w.d} className={!day && days === w.d ? "on" : ""} aria-pressed={!day && days === w.d}
                    onClick={() => { setDay(""); setDays(w.d); }}>{w.label}</button>
          ))}
        </div>
        <input type="date" aria-label="Specific date" value={day} max={new Date(Date.now()).toISOString().slice(0, 10)}
               onChange={(e) => setDay(e.target.value)} />
        <button className="primary" onClick={load} disabled={loading}>{loading ? "Loading…" : "Load"}</button>
      </div>

      {err && <div className="tr-err">{err}</div>}

      {!err && pts.length > 0 && (
        <>
          <div className="tr-meta">
            <span><strong>{pts.length}</strong> fixes</span>
            <span className="tr-legend"><i className="rf" /> RF <i className="app" /> app <i className="is" /> IS</span>
          </div>
          <div className="tr-player">
            <button className="tr-play" aria-label={playing ? "Pause" : "Play"} onClick={() => {
              if (idx >= pts.length - 1) setIdx(0);   // replay from start if at the end
              setPlaying((v) => !v);
            }}>{playing ? "⏸" : "▶"}</button>
            <input type="range" min={0} max={pts.length - 1} value={idx} aria-label="Scrub track"
                   onChange={(e) => { setPlaying(false); setIdx(+e.target.value); }} />
            <select aria-label="Playback speed" value={fps} onChange={(e) => setFps(+e.target.value)}>
              <option value={2}>1×</option><option value={8}>4×</option><option value={32}>16×</option>
            </select>
          </div>
          {cur && (
            <div className="tr-now mono">
              {fmt.dateTime(cur.ts)} ·{" "}
              <span className={`tr-via ${cur.heardVia === "rf" ? "rf" : cur.heardVia === "app" ? "app" : "is"}`}>
                {cur.heardVia === "rf" ? "RF" : cur.heardVia === "app" ? "app" : "IS"}
              </span>
            </div>
          )}
        </>
      )}
      {!err && !loading && pts.length === 0 && <div className="muted tr-empty">Pick a window and Load to see the track.</div>}
    </div>
  );
}
