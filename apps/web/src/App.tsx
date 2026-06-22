import { useEffect, useRef, useState, useCallback } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import {
  listCaches, getCache, createCache, logFind,
  type CacheSummary, type CacheDetail, type BBox, type AppGeo, type LogResult,
} from "./api.js";
import { typeMeta, TYPE_ORDER, TYPE_META } from "./cacheTypes.js";
import { ASSET } from "./brand.js";
import { buildGraticuleStyle } from "./offlineBasemap.js";
import type { CacheType, LogType } from "@aprsweb/shared";
import type { StyleSpecification } from "maplibre-gl";

const DEFAULT_CENTER: [number, number] = [15.42, 47.07]; // Graz, OE
// keyless online basemap by default; `VITE_BASEMAP=offline` uses the self-contained grid.
const STYLE: string | StyleSpecification =
  import.meta.env.VITE_BASEMAP === "offline"
    ? buildGraticuleStyle()
    : "https://demotiles.maplibre.org/style.json";

// ---------- callsign identity (localStorage until passkey sessions land) ----------
function useCallsign(): [string, (v: string) => void] {
  const [call, setCall] = useState(() => localStorage.getItem("acs.call") ?? "");
  const set = useCallback((v: string) => {
    const cs = v.toUpperCase().trim();
    setCall(cs);
    if (cs) localStorage.setItem("acs.call", cs); else localStorage.removeItem("acs.call");
  }, []);
  return [call, set];
}

type Mode = "view" | "hide";

export function App() {
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const markers = useRef<Map<number, maplibregl.Marker>>(new Map());
  const draftMarker = useRef<maplibregl.Marker | null>(null);
  const modeRef = useRef<Mode>("view");
  const debounce = useRef<ReturnType<typeof setTimeout>>();

  const [callsign, setCallsign] = useCallsign();
  const [caches, setCaches] = useState<CacheSummary[]>([]);
  const [mode, setMode] = useState<Mode>("view");
  const [draft, setDraft] = useState<{ lat: number; lon: number } | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<CacheDetail | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => { modeRef.current = mode; }, [mode]);

  const refresh = useCallback(async () => {
    const m = map.current; if (!m) return;
    const b = m.getBounds();
    const bbox: BBox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    try { setCaches((await listCaches(bbox)).caches); }
    catch (e) { console.error(e); }
    finally { setReady(true); }
  }, []);

  // ---- init map once ----
  useEffect(() => {
    if (!mapEl.current || map.current) return;
    const m = new maplibregl.Map({
      container: mapEl.current, style: STYLE, center: DEFAULT_CENTER, zoom: 9, hash: true,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    m.addControl(new maplibregl.GeolocateControl({ trackUserLocation: true }), "top-left");
    map.current = m;

    m.on("load", refresh);
    m.on("moveend", () => {
      clearTimeout(debounce.current);
      debounce.current = setTimeout(refresh, 250);
    });
    m.on("click", (e) => {
      if (modeRef.current !== "hide") return;
      const lat = +e.lngLat.lat.toFixed(6), lon = +e.lngLat.wrap().lng.toFixed(6);
      setDraft({ lat, lon });
      draftMarker.current?.remove();
      draftMarker.current = new maplibregl.Marker({ color: "#e53e3e", draggable: true })
        .setLngLat([lon, lat]).addTo(m);
      draftMarker.current.on("dragend", () => {
        const ll = draftMarker.current!.getLngLat();
        setDraft({ lat: +ll.lat.toFixed(6), lon: +ll.wrap().lng.toFixed(6) });
      });
    });
    return () => { m.remove(); map.current = null; };
  }, [refresh]);

  // ---- render cache markers (diffed against the live map) ----
  useEffect(() => {
    const m = map.current; if (!m) return;
    const seen = new Set<number>();
    for (const c of caches) {
      if (c.lat == null || c.lon == null) continue;
      seen.add(c.id);
      if (markers.current.has(c.id)) continue;
      const meta = typeMeta(c.type);
      let el: HTMLElement;
      let anchor: maplibregl.PositionAnchor = "bottom";
      if (c.type === "aprs_living") {
        // living caches ARE a beaconing station — use the brand beacon icon
        const img = document.createElement("img");
        img.className = "beacon-pin"; img.src = ASSET.beaconBlue; anchor = "center";
        el = img;
      } else {
        const btn = document.createElement("button");
        btn.className = "cache-pin"; btn.style.background = meta.color;
        btn.innerHTML = `<span>${meta.glyph}</span>`;
        el = btn;
      }
      el.title = `${c.code} — ${c.title}`;
      el.onclick = (ev) => { ev.stopPropagation(); setSelectedId(c.id); };
      const mk = new maplibregl.Marker({ element: el, anchor })
        .setLngLat([c.lon, c.lat]).addTo(m);
      markers.current.set(c.id, mk);
    }
    for (const [id, mk] of markers.current) {
      if (!seen.has(id)) { mk.remove(); markers.current.delete(id); }
    }
  }, [caches]);

  // ---- load detail when a cache is selected ----
  useEffect(() => {
    if (selectedId == null) { setDetail(null); return; }
    let live = true;
    getCache(selectedId).then((r) => { if (live) setDetail(r.cache); }).catch(console.error);
    return () => { live = false; };
  }, [selectedId]);

  const reloadDetail = useCallback(async () => {
    if (selectedId == null) return;
    try { setDetail((await getCache(selectedId)).cache); } catch (e) { console.error(e); }
  }, [selectedId]);

  function startHide() {
    setSelectedId(null);
    setMode("hide");
  }
  function cancelHide() {
    setMode("view");
    setDraft(null);
    draftMarker.current?.remove();
    draftMarker.current = null;
  }
  async function onCreated(c: CacheSummary) {
    cancelHide();
    await refresh();
    setSelectedId(c.id);
    if (c.lat != null && c.lon != null) map.current?.flyTo({ center: [c.lon, c.lat], zoom: 14 });
  }

  return (
    <div className="app">
      <TopBar callsign={callsign} setCallsign={setCallsign} mode={mode}
              onHide={startHide} onCancel={cancelHide} count={caches.length} />
      <div ref={mapEl} className="map" />
      {!ready && <div className="splash"><img src={ASSET.wordmark} alt="APRScaching" /></div>}

      {mode === "hide" && (
        <HidePanel callsign={callsign} draft={draft} onCancel={cancelHide} onCreated={onCreated} />
      )}

      {detail && mode === "view" && (
        <DetailPanel detail={detail} callsign={callsign}
                     onClose={() => setSelectedId(null)} onLogged={reloadDetail} />
      )}
    </div>
  );
}

// ----------------------------------------------------------------- top bar
function TopBar(props: {
  callsign: string; setCallsign: (v: string) => void; mode: Mode;
  onHide: () => void; onCancel: () => void; count: number;
}) {
  return (
    <header className="topbar">
      <img className="logo" src={ASSET.wordmark} alt="APRScaching" />
      <span className="muted">· {props.count} caches in view</span>
      <span className="spacer" />
      <label className="call">
        callsign&nbsp;
        <input value={props.callsign} placeholder="OE8APR"
               onChange={(e) => props.setCallsign(e.target.value)} size={9} />
      </label>
      {props.mode === "view"
        ? <button className="primary" onClick={props.onHide}>+ Hide a cache</button>
        : <button onClick={props.onCancel}>Cancel</button>}
    </header>
  );
}

// ----------------------------------------------------------------- hide a cache
function HidePanel(props: {
  callsign: string; draft: { lat: number; lon: number } | null;
  onCancel: () => void; onCreated: (c: CacheSummary) => void;
}) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<CacheType>("single");
  const [difficulty, setDifficulty] = useState(1.5);
  const [terrain, setTerrain] = useState(1.5);
  const [hint, setHint] = useState("");
  const [description, setDescription] = useState("");
  const [stationCall, setStationCall] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const ready = !!props.draft && title.trim().length > 0 && props.callsign.length >= 3;

  async function submit() {
    if (!props.draft) return;
    setBusy(true); setErr(null);
    try {
      const { cache } = await createCache({
        title: title.trim(), type, difficulty, terrain,
        lat: props.draft.lat, lon: props.draft.lon,
        ownerCall: props.callsign,
        hint: hint.trim() || undefined,
        description: description.trim() || undefined,
        stationCall: type === "aprs_living" ? (stationCall.trim().toUpperCase() || undefined) : undefined,
      });
      props.onCreated(cache);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <aside className="panel left">
      <h2>Hide a cache</h2>
      <p className="muted">
        {props.draft
          ? <>Pin at <code>{props.draft.lat.toFixed(5)}, {props.draft.lon.toFixed(5)}</code> — drag to adjust.</>
          : <>Click the map to drop the cache location.</>}
      </p>
      <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <label>Type
        <select value={type} onChange={(e) => setType(e.target.value as CacheType)}>
          {TYPE_ORDER.map((t) => <option key={t} value={t}>{TYPE_META[t].label}</option>)}
        </select>
      </label>
      {type === "aprs_living" && (
        <label>Station callsign (the beaconing station that <em>is</em> the cache)
          <input value={stationCall} onChange={(e) => setStationCall(e.target.value)} placeholder="OE8XYZ-9" />
        </label>
      )}
      <div className="row">
        <label>Difficulty {difficulty.toFixed(1)}
          <input type="range" min={1} max={5} step={0.5} value={difficulty}
                 onChange={(e) => setDifficulty(+e.target.value)} /></label>
        <label>Terrain {terrain.toFixed(1)}
          <input type="range" min={1} max={5} step={0.5} value={terrain}
                 onChange={(e) => setTerrain(+e.target.value)} /></label>
      </div>
      <label>Hint<input value={hint} onChange={(e) => setHint(e.target.value)} /></label>
      <label>Description
        <textarea value={description} rows={3} onChange={(e) => setDescription(e.target.value)} /></label>
      {err && <p className="error">{err}</p>}
      <div className="row end">
        <button onClick={props.onCancel}>Cancel</button>
        <button className="primary" disabled={!ready || busy} onClick={submit}>
          {busy ? "Hiding…" : "Hide cache"}
        </button>
      </div>
      {props.callsign.length < 3 && <p className="muted">Set your callsign (top bar) to own a cache.</p>}
    </aside>
  );
}

// ----------------------------------------------------------------- cache detail + log
function DetailPanel(props: {
  detail: CacheDetail; callsign: string; onClose: () => void; onLogged: () => void;
}) {
  const c = props.detail;
  const meta = typeMeta(c.type);
  return (
    <aside className="panel right">
      <div className="row between">
        <h2><span className="dot" style={{ background: meta.color }} /> {c.code}</h2>
        <button className="icon" onClick={props.onClose}>✕</button>
      </div>
      <h3>{c.title}</h3>
      <p className="muted">
        {meta.label} · D {c.difficulty.toFixed(1)} / T {c.terrain.toFixed(1)} · by {c.ownerCall}
        {c.minTrust && <> · requires tier {c.minTrust}</>}
      </p>
      <p><strong>{c.finds}</strong> verified find{c.finds === 1 ? "" : "s"}
        {c.status !== "active" && <> · <em>{c.status}</em></>}</p>
      {c.description && <p>{c.description}</p>}
      {c.hint && <details><summary>Hint</summary><p>{c.hint}</p></details>}

      <LogForm cacheId={c.id} callsign={props.callsign} onLogged={props.onLogged} />

      <h4>Logbook</h4>
      {c.logs.length === 0 && <p className="muted">No logs yet — be the first to find it.</p>}
      <ul className="logs">
        {c.logs.map((l) => (
          <li key={l.id}>
            <span className={`badge ${l.logType}`}>{l.logType}</span>
            <strong>{l.loggerCall}</strong>
            {l.logType === "found" && (
              l.verified
                ? <span className="ok">✓ tier {l.tier}</span>
                : <span className="muted">unverified{l.tier ? ` (tier ${l.tier})` : ""}</span>
            )}
            <span className="muted"> · {new Date(l.ts * 1000).toLocaleDateString()}</span>
            {l.comment && <div className="comment">{l.comment}</div>}
          </li>
        ))}
      </ul>
    </aside>
  );
}

// ----------------------------------------------------------------- log form
function LogForm(props: { cacheId: number; callsign: string; onLogged: () => void }) {
  const [logType, setLogType] = useState<LogType>("found");
  const [comment, setComment] = useState("");
  const [useGeo, setUseGeo] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LogResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function getGeo(): Promise<AppGeo | undefined> {
    if (!useGeo || logType !== "found" || !navigator.geolocation) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({
          lat: p.coords.latitude, lon: p.coords.longitude,
          accuracyM: p.coords.accuracy ?? 9999, ts: Math.floor(p.timestamp / 1000),
        }),
        () => resolve(undefined),
        { enableHighAccuracy: true, timeout: 8000 },
      );
    });
  }

  async function submit() {
    if (props.callsign.length < 3) { setErr("Set your callsign in the top bar first."); return; }
    setBusy(true); setErr(null); setResult(null);
    try {
      const appGeo = await getGeo();
      const r = await logFind(props.cacheId, {
        loggerCall: props.callsign, logType, comment: comment.trim() || undefined, appGeo,
      });
      setResult(r); setComment(""); props.onLogged();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="logform">
      <div className="row">
        <select value={logType} onChange={(e) => setLogType(e.target.value as LogType)}>
          <option value="found">Found it</option>
          <option value="dnf">Did not find</option>
          <option value="note">Note</option>
        </select>
        {logType === "found" && (
          <label className="geo">
            <input type="checkbox" checked={useGeo} onChange={(e) => setUseGeo(e.target.checked)} />
            use my location (tier&nbsp;B)
          </label>
        )}
      </div>
      <textarea placeholder="Comment (optional)" rows={2}
                value={comment} onChange={(e) => setComment(e.target.value)} />
      <button className="primary" disabled={busy} onClick={submit}>
        {busy ? "Logging…" : "Log it"}
      </button>
      {err && <p className="error">{err}</p>}
      {result && (
        <p className={result.verified ? "ok" : "muted"}>
          {result.logType === "found"
            ? (result.verified
                ? `Verified — tier ${result.tier} (${result.method}${result.distanceM != null ? `, ${Math.round(result.distanceM)} m` : ""})`
                : `Logged, unverified${result.reason ? ` — ${result.reason}` : ""}`)
            : "Logged."}
          {result.announced && " · announced to APRS-IS"}
        </p>
      )}
    </div>
  );
}
