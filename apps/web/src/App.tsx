import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import {
  listCaches, getCache, createCache, logFind, registerKey, getInstance, API_BASE,
  getLeaderboard, getProfile, toggleFavorite, getStations, getStation, decodePacket,
  getPorts, getMessages, cotUrl, getStages, unlockStage, mediaUrl, exportAccount, deleteAccount,
  getBbsInbox, getBulletins, postBbsMessage, getActivity, flushLogQueue, queuedLogCount,
  type CacheSummary, type CacheDetail, type MapCache, type BBox, type AppGeo, type LogResult,
  type LeaderboardEntry, type Profile, type StationSummary, type StationDetail, type DecodedPacket,
  type PortStat, type MessageItem, type CacheStage, type BbsMessage, type ActivityItem,
} from "./api.js";
import { signAuthorship, signAccountAction } from "./crypto.js";
import type { GeofencePrompt } from "@aprsweb/shared";
import { typeMeta, TYPE_ORDER, TYPE_META } from "./cacheTypes.js";
import { ASSET } from "./brand.js";
import { buildGraticuleStyle } from "./offlineBasemap.js";
import {
  FormatContext, useFmt, makeFormatters, loadSettings, saveSettings, resolveTheme,
  browserLocale, browserTimeZone, type LocaleSettings,
} from "./format.js";
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

/** Great-circle distance in metres (local copy; the web doesn't depend on @aprsweb/aprs). */
function haversine(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371000, d = Math.PI / 180;
  const dLat = (bLat - aLat) * d, dLon = (bLon - aLon) * d;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * d) * Math.cos(bLat * d) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function App() {
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const markers = useRef<Map<string, maplibregl.Marker>>(new Map());
  const draftMarker = useRef<maplibregl.Marker | null>(null);
  const modeRef = useRef<Mode>("view");
  const debounce = useRef<ReturnType<typeof setTimeout>>();

  const [callsign, setCallsign] = useCallsign();
  const [caches, setCaches] = useState<MapCache[]>([]);
  const [mode, setMode] = useState<Mode>("view");
  const [draft, setDraft] = useState<{ lat: number; lon: number } | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<CacheDetail | null>(null);
  const [remote, setRemote] = useState<MapCache | null>(null); // a mirrored (peer) cache, read-only
  const [ready, setReady] = useState(false);
  const [nearPrompt, setNearPrompt] = useState<GeofencePrompt | null>(null);
  const [showBoard, setShowBoard] = useState(false);
  const [showWB, setShowWB] = useState(false);
  const [showMail, setShowMail] = useState(false);
  const [showNearby, setShowNearby] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showFilter, setShowFilter] = useState(false);
  const [filters, setFilters] = useState<{ types: CacheType[]; q: string }>({ types: [], q: "" });
  const [stationsOn, setStationsOn] = useState(false);
  const [stations, setStations] = useState<StationSummary[]>([]);
  const [pickedStation, setPickedStation] = useState<string | null>(null);
  const [locSettings, setLocSettings] = useState<LocaleSettings>(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const fmt = useMemo(() => makeFormatters(locSettings), [locSettings]);
  const applySettings = useCallback((s: LocaleSettings) => { setLocSettings(s); saveSettings(s); }, []);

  // apply the field-console theme to the document root (dark default; honours OS for "auto")
  useEffect(() => {
    const apply = () => { document.documentElement.dataset.theme = resolveTheme(locSettings.theme); };
    apply();
    if (locSettings.theme === "auto" && window.matchMedia) {
      const mq = window.matchMedia("(prefers-color-scheme: light)");
      mq.addEventListener?.("change", apply);
      return () => mq.removeEventListener?.("change", apply);
    }
  }, [locSettings.theme]);

  // single-overlay model: close everything, then a nav handler opens exactly one surface
  const closeAll = useCallback(() => {
    setShowBoard(false); setShowWB(false); setShowMail(false); setShowNearby(false);
    setShowActivity(false); setShowProfile(false); setShowSettings(false);
    setSelectedId(null); setRemote(null);
  }, []);
  const openOnly = useCallback((open: () => void) => { closeAll(); open(); }, [closeAll]);

  // caches that pass the active filters (type + text) — drives the markers, Nearby and the count
  const shown = useMemo(() => caches.filter((c) =>
    (filters.types.length === 0 || filters.types.includes(c.type)) &&
    (!filters.q || `${c.code} ${c.title ?? ""}`.toLowerCase().includes(filters.q.toLowerCase())),
  ), [caches, filters]);

  const ws = useRef<WebSocket | null>(null);
  const stationMarkers = useRef<Map<string, maplibregl.Marker>>(new Map());
  const stationsOnRef = useRef(stationsOn);
  useEffect(() => { stationsOnRef.current = stationsOn; }, [stationsOn]);
  const callsignRef = useRef(callsign);
  useEffect(() => { callsignRef.current = callsign; }, [callsign]);
  useEffect(() => { modeRef.current = mode; }, [mode]);

  // (re)subscribe the live socket to the current viewport + callsign
  const subscribeLive = useCallback((bbox: BBox) => {
    const s = ws.current;
    if (s && s.readyState === WebSocket.OPEN) {
      s.send(JSON.stringify({ type: "subscribe", bbox, maxAgeSec: 3600, callsign: callsignRef.current || undefined }));
    }
  }, []);

  const refresh = useCallback(async () => {
    const m = map.current; if (!m) return;
    const b = m.getBounds();
    const bbox: BBox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    subscribeLive(bbox);
    try { setCaches((await listCaches(bbox)).caches); }
    catch (e) { console.error(e); }
    finally { setReady(true); }
    if (stationsOnRef.current) {
      try { setStations((await getStations(bbox)).stations); } catch (e) { console.error(e); }
    }
  }, [subscribeLive]);

  // flush any finds queued while offline — on load and whenever connectivity returns
  const [queued, setQueued] = useState(queuedLogCount());
  useEffect(() => {
    const sync = async () => { if (await flushLogQueue()) { setQueued(queuedLogCount()); refresh(); } };
    sync();
    const onq = () => setQueued(queuedLogCount());
    window.addEventListener("online", sync);
    window.addEventListener("acs-queued", onq);
    return () => { window.removeEventListener("online", sync); window.removeEventListener("acs-queued", onq); };
  }, [refresh]);

  // live WebSocket: geofence prompts ("you're near a cache")
  useEffect(() => {
    const s = new WebSocket(API_BASE.replace(/^http/, "ws") + "/ws?region=global");
    ws.current = s;
    s.addEventListener("open", () => { const m = map.current; if (m) { const b = m.getBounds(); subscribeLive([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]); } });
    s.addEventListener("message", (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "near_cache") setNearPrompt(msg);
        else if (msg.type === "station" && stationsOnRef.current) {
          setStations((prev) => {
            const next = prev.filter((p) => p.callsign !== msg.callsign);
            next.unshift({ callsign: msg.callsign, lat: msg.lat, lon: msg.lon, symbol: msg.symbol ?? null,
              course: msg.course ?? null, speedKn: null, altitudeM: null, comment: null, lastSeen: msg.lastSeen });
            return next.slice(0, 500);
          });
        }
      } catch { /* ignore */ }
    });
    return () => { try { s.close(); } catch { /* */ } ws.current = null; };
  }, [subscribeLive]);

  // re-subscribe when the callsign changes so prompts are addressed to you
  useEffect(() => {
    const m = map.current; if (!m) return;
    const b = m.getBounds();
    subscribeLive([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
  }, [callsign, subscribeLive]);

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
    const seen = new Set<string>();
    for (const c of shown) {
      if (c.lat == null || c.lon == null) continue;
      seen.add(c.globalId);
      if (markers.current.has(c.globalId)) continue;
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
        btn.className = `cache-pin${c.mirrored ? " mirrored" : ""}`; btn.style.background = meta.color;
        btn.innerHTML = `<span>${meta.glyph}</span>`;
        el = btn;
      }
      el.title = `${c.code} — ${c.title}${c.mirrored ? ` · via ${c.origin}` : ""}`;
      el.onclick = (ev) => {
        ev.stopPropagation();
        if (c.mirrored) { setSelectedId(null); setRemote(c); }
        else if (c.id != null) { setRemote(null); setSelectedId(c.id); }
      };
      const mk = new maplibregl.Marker({ element: el, anchor })
        .setLngLat([c.lon, c.lat]).addTo(m);
      markers.current.set(c.globalId, mk);
    }
    for (const [gid, mk] of markers.current) {
      if (!seen.has(gid)) { mk.remove(); markers.current.delete(gid); }
    }
  }, [shown]);

  // ---- live APRS stations layer (toggled from the workbench) ----
  useEffect(() => {
    if (stationsOn) { refresh(); }
    else { for (const [, mk] of stationMarkers.current) mk.remove(); stationMarkers.current.clear(); setStations([]); setPickedStation(null); }
  }, [stationsOn, refresh]);

  useEffect(() => {
    const m = map.current; if (!m) return;
    if (!stationsOn) return;
    const seen = new Set<string>();
    for (const s of stations) {
      if (s.lat == null || s.lon == null) continue;
      seen.add(s.callsign);
      let mk = stationMarkers.current.get(s.callsign);
      if (!mk) {
        const btn = document.createElement("button");
        btn.className = "station-pin";
        btn.innerHTML = "<span></span>";
        btn.onclick = (ev) => { ev.stopPropagation(); setPickedStation(s.callsign); setShowWB(true); };
        mk = new maplibregl.Marker({ element: btn, anchor: "center" }).setLngLat([s.lon, s.lat]).addTo(m);
        stationMarkers.current.set(s.callsign, mk);
      } else {
        mk.setLngLat([s.lon, s.lat]);
      }
      const el = mk.getElement();
      el.title = `${s.callsign}${s.comment ? ` — ${s.comment}` : ""}`;
      const moving = s.course != null && !!s.speedKn;
      const span = el.querySelector("span") as HTMLElement;
      span.textContent = moving ? "➤" : "•";
      span.style.transform = moving ? `rotate(${(s.course ?? 0) - 90}deg)` : "";
    }
    for (const [cs, mk] of stationMarkers.current) {
      if (!seen.has(cs)) { mk.remove(); stationMarkers.current.delete(cs); }
    }
  }, [stations, stationsOn]);

  // ---- load detail when a cache is selected ----
  useEffect(() => {
    if (selectedId == null) { setDetail(null); return; }
    let live = true;
    getCache(selectedId, callsignRef.current).then((r) => { if (live) setDetail(r.cache); }).catch(console.error);
    return () => { live = false; };
  }, [selectedId]);

  const reloadDetail = useCallback(async () => {
    if (selectedId == null) return;
    try { setDetail((await getCache(selectedId, callsignRef.current)).cache); } catch (e) { console.error(e); }
  }, [selectedId]);

  function startHide() {
    setSelectedId(null);
    setRemote(null);
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
    <FormatContext.Provider value={fmt}>
    <div className="app">
      <TopBar callsign={callsign} setCallsign={setCallsign} mode={mode}
              onHide={startHide} onCancel={cancelHide} count={shown.length} queued={queued}
              onFilters={() => openOnly(() => setShowFilter(true))}
              filtered={filters.types.length > 0 || filters.q.length > 0}
              onNearby={() => openOnly(() => setShowNearby(true))}
              onActivity={() => openOnly(() => setShowActivity(true))}
              onProfile={() => openOnly(() => setShowProfile(true))} />
      <div ref={mapEl} className="map" />
      {!ready && <div className="splash"><img src={ASSET.wordmark} alt="APRScaching" /></div>}

      {nearPrompt && mode === "view" && (
        <div className="geo-banner">
          <span>📍 You're near <strong>{nearPrompt.code}</strong> — {nearPrompt.title}
            <span className="muted"> · {fmt.distance(nearPrompt.distanceM)}</span></span>
          <span className="spacer" />
          <button className="primary" onClick={() => {
            setRemote(null); setSelectedId(nearPrompt.cacheId); setNearPrompt(null);
            map.current?.flyTo({ center: map.current.getCenter(), zoom: Math.max(map.current.getZoom(), 14) });
          }}>Log it</button>
          <button className="icon" onClick={() => setNearPrompt(null)}>✕</button>
        </div>
      )}

      {mode === "hide" && (
        <HidePanel callsign={callsign} draft={draft} onCancel={cancelHide} onCreated={onCreated} />
      )}

      {showNearby && mode === "view" && (
        <NearbyPanel caches={shown} map={map.current}
                     onPick={(id) => openOnly(() => setSelectedId(id))} onClose={() => setShowNearby(false)} />
      )}

      {showActivity && mode === "view" && (
        <ActivityPanel map={map.current} onBoard={() => openOnly(() => setShowBoard(true))} onClose={() => setShowActivity(false)} />
      )}

      {showFilter && mode === "view" && (
        <FilterPanel filters={filters} setFilters={setFilters} count={shown.length} onClose={() => setShowFilter(false)} />
      )}

      {showProfile && mode === "view" && (
        <ProfilePanel callsign={callsign} map={map.current}
                      onWorkbench={() => openOnly(() => setShowWB(true))}
                      onMail={() => openOnly(() => setShowMail(true))}
                      onSettings={() => openOnly(() => setShowSettings(true))}
                      onClose={() => setShowProfile(false)} />
      )}

      {showBoard && mode === "view" && (
        <CommunityPanel map={map.current} onClose={() => setShowBoard(false)} />
      )}

      {showWB && mode === "view" && (
        <WorkbenchPanel onClose={() => setShowWB(false)} map={map.current}
                        stationsOn={stationsOn} setStationsOn={setStationsOn}
                        stationCount={stations.length}
                        picked={pickedStation} onPick={setPickedStation}
                        onFly={(lat, lon) => map.current?.flyTo({ center: [lon, lat], zoom: Math.max(map.current.getZoom(), 12) })} />
      )}

      {detail && mode === "view" && !remote && !showBoard && (
        <DetailPanel detail={detail} callsign={callsign}
                     onClose={() => setSelectedId(null)} onLogged={reloadDetail} />
      )}

      {remote && mode === "view" && !showBoard && (
        <RemoteCachePanel cache={remote} onClose={() => setRemote(null)} />
      )}

      {showMail && mode === "view" && (
        <MailPanel callsign={callsign} onClose={() => setShowMail(false)} />
      )}

      {showSettings && (
        <SettingsPanel settings={locSettings} onApply={applySettings} callsign={callsign} onClose={() => setShowSettings(false)} />
      )}

      {mode === "view" && (
        <TabBar
          active={showNearby ? "nearby" : showActivity ? "activity" : showProfile ? "profile" : "map"}
          onMap={closeAll}
          onNearby={() => openOnly(() => setShowNearby(true))}
          onActivity={() => openOnly(() => setShowActivity(true))}
          onProfile={() => openOnly(() => setShowProfile(true))}
          fabLabel={selectedId != null || nearPrompt ? "Log" : "Hide"}
          onFab={() => {
            if (nearPrompt) openOnly(() => setSelectedId(nearPrompt.cacheId));
            else if (selectedId == null) startHide();
          }} />
      )}
    </div>
    </FormatContext.Provider>
  );
}

// ----------------------------------------------------------------- locale & units settings
function SettingsPanel(props: { settings: LocaleSettings; onApply: (s: LocaleSettings) => void; callsign: string; onClose: () => void }) {
  const s = props.settings;
  const fmt = useFmt();
  const now = Math.floor(Date.now() / 1000);
  const [gdpr, setGdpr] = useState<string | null>(null);

  async function exportData() {
    setGdpr("Preparing your export…");
    try {
      const inst = await getInstance();
      const auth = await signAccountAction("export", props.callsign, inst);
      if (!auth) { setGdpr("This browser can't sign (needs Ed25519). Try a recent Chrome/Firefox/Safari."); return; }
      const data = await exportAccount(props.callsign, auth);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = document.createElement("a"); a.href = url; a.download = `aprscaching-${props.callsign}.json`; a.click();
      URL.revokeObjectURL(url); setGdpr("Export downloaded.");
    } catch (e) { setGdpr((e as Error).message); }
  }
  async function deleteData() {
    if (!confirm(`Permanently erase ${props.callsign}? Your finds are anonymised and your account, keys and personal data are deleted. This cannot be undone.`)) return;
    setGdpr("Erasing…");
    try {
      const inst = await getInstance();
      const auth = await signAccountAction("delete", props.callsign, inst);
      if (!auth) { setGdpr("This browser can't sign (needs Ed25519)."); return; }
      await deleteAccount(props.callsign, auth);
      setGdpr("Your account and personal data were erased.");
    } catch (e) { setGdpr((e as Error).message); }
  }
  return (
    <aside className="panel right">
      <div className="row between"><h2>⚙ Settings</h2><button className="icon" onClick={props.onClose}>✕</button></div>

      <h4>Appearance</h4>
      <div className="row">
        {(["dark", "light", "auto"] as const).map((t) => (
          <button key={t} className={s.theme === t ? "primary" : ""} onClick={() => props.onApply({ ...s, theme: t })} style={{ textTransform: "capitalize" }}>{t}</button>
        ))}
      </div>

      <h4>Units</h4>
      <div className="row">
        <button className={s.units === "metric" ? "primary" : ""} onClick={() => props.onApply({ ...s, units: "metric" })}>Metric</button>
        <button className={s.units === "imperial" ? "primary" : ""} onClick={() => props.onApply({ ...s, units: "imperial" })}>Imperial</button>
      </div>

      <label>Locale
        <input value={s.locale} placeholder={`browser (${browserLocale()})`}
               onChange={(e) => props.onApply({ ...s, locale: e.target.value.trim() })} />
      </label>
      <label>Time zone
        <input value={s.timeZone} placeholder={`browser (${browserTimeZone()})`}
               onChange={(e) => props.onApply({ ...s, timeZone: e.target.value.trim() })} />
      </label>
      <p className="muted" style={{ marginTop: 4 }}>Blank = follow the browser. Resolved: <strong>{fmt.resolvedLocale}</strong> · {fmt.resolvedTimeZone}</p>

      <h4>Preview</h4>
      <ul className="board">
        <li><span className="rank" style={{ width: 80 }}>now</span> {fmt.dateTime(now)}</li>
        <li><span className="rank" style={{ width: 80 }}>distance</span> {fmt.distance(1234)} · {fmt.distance(85)}</li>
        <li><span className="rank" style={{ width: 80 }}>speed</span> {fmt.speed(36)}</li>
        <li><span className="rank" style={{ width: 80 }}>altitude</span> {fmt.altitude(376)}</li>
        <li><span className="rank" style={{ width: 80 }}>temp</span> {fmt.temp(18)}</li>
      </ul>

      <h4>Your data</h4>
      {props.callsign.length < 3 ? (
        <p className="muted">Set your callsign (top bar) to export or erase your data.</p>
      ) : (<>
        <p className="muted">Signed with your device key for <strong>{props.callsign}</strong>. Export gives you a full copy; erase anonymises your finds and removes your account, keys and personal data (GDPR / DSGVO).</p>
        <div className="row">
          <button onClick={exportData}>Export my data</button>
          <button onClick={deleteData} style={{ color: "#c0392b", borderColor: "#e8b5ad" }}>Erase my account</button>
        </div>
        {gdpr && <p className="muted" style={{ marginTop: 6 }}>{gdpr}</p>}
      </>)}
    </aside>
  );
}

// ----------------------------------------------------------------- community: leaderboard + profile
function CommunityPanel(props: { map: maplibregl.Map | null; onClose: () => void }) {
  const fmt = useFmt();
  const [metric, setMetric] = useState<"points" | "finds">("points");
  const [rows, setRows] = useState<LeaderboardEntry[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    const m = props.map; if (!m) return;
    const b = m.getBounds();
    setLoading(true);
    try { setRows((await getLeaderboard([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], metric)).leaderboard); }
    catch (e) { console.error(e); } finally { setLoading(false); }
  }, [props.map, metric]);
  useEffect(() => { if (!profile) void load(); }, [load, profile]);

  if (profile) {
    return (
      <aside className="panel right">
        <div className="row between">
          <h2>{profile.callsign}{profile.accountVerified && <span className="ok"> ✓</span>}</h2>
          <button className="icon" onClick={props.onClose}>✕</button>
        </div>
        <button onClick={() => setProfile(null)}>← leaderboard</button>
        <p style={{ marginTop: 12 }}><strong>{profile.finds}</strong> finds · <strong>{profile.points}</strong> pts · {profile.hides} hidden</p>
        {profile.lastFind && <p className="muted">last find {fmt.date(profile.lastFind)}</p>}
        <h4>Badges</h4>
        {profile.badges.length
          ? <div className="badges">{profile.badges.map((b) => <span key={b.badge} className="award">{b.badge}</span>)}</div>
          : <p className="muted">No badges yet.</p>}
        <h4>Finds by type</h4>
        <div className="badges">{Object.entries(profile.byType).map(([t, n]) => <span key={t} className="badge">{t}: {n}</span>)}</div>
      </aside>
    );
  }
  return (
    <aside className="panel right">
      <div className="row between"><h2>🏆 Leaderboard</h2><button className="icon" onClick={props.onClose}>✕</button></div>
      <div className="row">
        <button className={metric === "points" ? "primary" : ""} onClick={() => setMetric("points")}>Points</button>
        <button className={metric === "finds" ? "primary" : ""} onClick={() => setMetric("finds")}>Finds</button>
        <span className="spacer" /><button onClick={load}>↻ this area</button>
      </div>
      {loading && <p className="muted">Loading…</p>}
      {!loading && !rows.length && <p className="muted">No verified finds in this area yet.</p>}
      <ol className="board">
        {rows.map((r) => (
          <li key={r.loggerCall}>
            <span className="rank">{r.rank}</span>
            <button className="link" onClick={() => getProfile(r.loggerCall).then(setProfile).catch(console.error)}>{r.loggerCall}</button>
            <span className="spacer" />
            <strong>{metric === "points" ? r.points : r.finds}</strong>
            <span className="muted">&nbsp;{metric === "points" ? "pts" : "finds"}</span>
          </li>
        ))}
      </ol>
    </aside>
  );
}

// ----------------------------------------------------------------- mirrored (peer) cache — read-only
function RemoteCachePanel(props: { cache: MapCache; onClose: () => void }) {
  const c = props.cache;
  const meta = typeMeta(c.type);
  return (
    <aside className="panel right">
      <div className="row between">
        <h2><span className="dot" style={{ background: meta.color }} /> <span className="code">{c.code}</span></h2>
        <button className="icon" onClick={props.onClose}>✕</button>
      </div>
      <h3>{c.title}</h3>
      <p className="muted">
        {meta.label} · D {c.difficulty.toFixed(1)} / T {c.terrain.toFixed(1)} · by {c.ownerCall}
      </p>
      <p className="federated">⇄ mirrored from <strong>{c.origin}</strong></p>
      <p className="muted">
        This cache lives on another instance in the network. Log your find on its home instance;
        it will appear here once that instance publishes it.
      </p>
    </aside>
  );
}

// ----------------------------------------------------------------- workbench: stations + packet inspector
function WorkbenchPanel(props: {
  onClose: () => void; map: maplibregl.Map | null;
  stationsOn: boolean; setStationsOn: (v: boolean) => void; stationCount: number;
  picked: string | null; onPick: (cs: string | null) => void; onFly: (lat: number, lon: number) => void;
}) {
  const [raw, setRaw] = useState("");
  const [decoded, setDecoded] = useState<DecodedPacket | null>(null);
  const [station, setStation] = useState<StationDetail | null>(null);
  const [ports, setPorts] = useState<PortStat[]>([]);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [copied, setCopied] = useState(false);
  const fmt = useFmt();

  useEffect(() => {
    getPorts().then((r) => setPorts(r.ports)).catch(console.error);
    getMessages().then((r) => setMessages(r.messages)).catch(console.error);
  }, []);

  const feedUrl = (() => {
    const b = props.map?.getBounds();
    return b ? cotUrl([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]) : "";
  })();

  useEffect(() => {
    if (!props.picked) { setStation(null); return; }
    let live = true;
    getStation(props.picked).then((r) => { if (live) setStation(r.station); }).catch(console.error);
    return () => { live = false; };
  }, [props.picked]);

  async function decode() {
    try { setDecoded(await decodePacket(raw.trim())); }
    catch (e) { setDecoded({ ok: false, error: (e as Error).message }); }
  }

  const SAMPLE = "OE8APR-9>APRS,WIDE1-1,qAR,OE8XXX:!4704.41N/01526.27E>088/036/A=001234Mobile";

  return (
    <aside className="panel right">
      <div className="row between"><h2>📡 Workbench</h2><button className="icon" onClick={props.onClose}>✕</button></div>

      <h4>Live stations</h4>
      <div className="row between">
        <label className="geo" style={{ margin: 0 }}>
          <input type="checkbox" checked={props.stationsOn} onChange={(e) => props.setStationsOn(e.target.checked)} style={{ width: "auto" }} />
          &nbsp;show APRS stations on the map
        </label>
        {props.stationsOn && <span className="muted">{props.stationCount}</span>}
      </div>

      {station && (
        <div className="logform" style={{ marginTop: 10 }}>
          <div className="row between">
            <h3 className="mono" style={{ margin: 0 }}>{station.callsign}</h3>
            <button className="link" onClick={() => props.onPick(null)}>clear</button>
          </div>
          <div className="muted">{station.symbol ?? "—"} · last heard {fmt.ago(station.lastSeen)}</div>
          {station.comment && <div className="comment">{station.comment}</div>}
          <div className="muted" style={{ marginTop: 4 }}>
            {station.speedKn != null && station.speedKn > 0 ? `${fmt.speed(station.speedKn)} @ ${station.course ?? 0}° · ` : ""}
            {station.altitudeM != null ? `${fmt.altitude(station.altitudeM)} · ` : ""}
            {station.packets} pkts · {station.track.length} track pts
          </div>
          {station.wx && (
            <div className="wx">
              {station.wx.tempC != null && <>🌡 {fmt.temp(station.wx.tempC)} · </>}
              💧 {station.wx.humidity ?? "—"}% ·{" "}
              {station.wx.windKn != null && <>🌬 {fmt.speed(station.wx.windKn)} · </>}
              {station.wx.pressureHpa ?? "—"} hPa</div>
          )}
          <div className="row end" style={{ marginTop: 8 }}>
            <button onClick={() => props.onFly(station.lat, station.lon)}>fly to</button>
          </div>
        </div>
      )}

      <h4>Packet decoder</h4>
      <textarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={3} placeholder="paste a raw TNC2 / APRS-IS line…" />
      <div className="row between" style={{ marginTop: 6 }}>
        <button className="link" onClick={() => setRaw(SAMPLE)}>use a sample</button>
        <button className="primary" onClick={decode} disabled={!raw.trim()}>Decode</button>
      </div>
      {decoded && !decoded.ok && <p className="error">{decoded.error}</p>}
      {decoded?.ok && decoded.frame && (
        <div className="decoded">
          <div className="row between">
            <strong>{decoded.frame.src}</strong>
            <span className={`badge ${decoded.frame.heardVia === "rf" ? "found" : ""}`}>{decoded.frame.heardVia}</span>
          </div>
          <div className="muted">→ {decoded.frame.dst} · {decoded.frame.path.join(" · ") || "(no path)"}</div>
          <div className="kind">{String(decoded.data?.kind)}</div>
          <dl className="fields">
            {decoded.data && Object.entries(flatten(decoded.data)).map(([k, v]) => (
              <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
            ))}
          </dl>
        </div>
      )}

      <h4>Transports <span className="muted" style={{ fontWeight: 400 }}>· 24h RX</span></h4>
      {ports.length === 0 ? <p className="muted">no traffic yet</p> : (
        <ul className="board">
          {ports.map((p) => (
            <li key={p.port}><span className="federated" style={{ flex: 1 }}>{p.port}</span>
              <span>{fmt.num(p.rx, 0)} rx</span></li>
          ))}
        </ul>
      )}

      <h4>TAK / CoT feed</h4>
      <p className="muted">Add this as a data feed in ATAK/WinTAK to see APRS stations as CoT:</p>
      <div className="row">
        <input readOnly value={feedUrl} onFocus={(e) => e.currentTarget.select()} />
        <button onClick={() => { navigator.clipboard?.writeText(feedUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "✓" : "copy"}</button>
      </div>

      {messages.length > 0 && (<>
        <h4>Recent messages</h4>
        <ul className="logs">
          {messages.map((mm) => (
            <li key={mm.id}>
              <span className="badge">{mm.fromCall}</span>→ {mm.toCall} <span className="muted">· {fmt.ago(mm.ts)}</span>
              <div className="comment">{mm.body}</div>
            </li>
          ))}
        </ul>
      </>)}
    </aside>
  );
}

function flatten(data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === "kind") continue;
    if (v == null) continue;
    if (typeof v === "object") {
      if (k === "symbol" && (v as any).label) { out.symbol = `${(v as any).label} (${(v as any).table}${(v as any).code})`; continue; }
      out[k] = JSON.stringify(v);
    } else out[k] = String(v);
  }
  return out;
}

// ----------------------------------------------------------------- BBS mail + bulletins
function MailPanel(props: { callsign: string; onClose: () => void }) {
  const fmt = useFmt();
  const [tab, setTab] = useState<"inbox" | "bulletins" | "compose">("inbox");
  const [inbox, setInbox] = useState<BbsMessage[]>([]);
  const [bulletins, setBulletins] = useState<BbsMessage[]>([]);
  const [to, setTo] = useState(""); const [body, setBody] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    if (props.callsign.length >= 3) getBbsInbox(props.callsign).then((r) => setInbox(r.messages)).catch(console.error);
    getBulletins().then((r) => setBulletins(r.bulletins)).catch(console.error);
  }, [props.callsign]);
  useEffect(() => { load(); }, [load]);

  async function send() {
    if (!to.trim() || !body.trim() || props.callsign.length < 3) { setMsg("Set your callsign, a recipient and a message."); return; }
    try {
      const r = await postBbsMessage({ fromCall: props.callsign, toCall: to.trim().toUpperCase(), body: body.trim() });
      setMsg(r.type === "B" ? "Bulletin posted." : "Held — it'll be delivered when the station is next heard.");
      setBody(""); setTo(""); load();
    } catch (e) { setMsg((e as Error).message); }
  }

  const status = (m: BbsMessage) => ({ held: "⏳ held", sent: "📡 sent", acked: "✓ delivered", expired: "✕ expired" } as Record<string, string>)[m.delivery ?? ""] ?? "";
  return (
    <aside className="panel right">
      <div className="row between"><h2>✉ BBS</h2><button className="icon" onClick={props.onClose}>✕</button></div>
      <div className="row" style={{ gap: 6 }}>
        <button className={tab === "inbox" ? "primary" : ""} onClick={() => setTab("inbox")}>Inbox</button>
        <button className={tab === "bulletins" ? "primary" : ""} onClick={() => setTab("bulletins")}>Bulletins</button>
        <button className={tab === "compose" ? "primary" : ""} onClick={() => setTab("compose")}>Compose</button>
      </div>

      {tab === "inbox" && (props.callsign.length < 3 ? <p className="muted">Set your callsign to see your mail.</p> :
        inbox.length === 0 ? <p className="muted">No messages for {props.callsign}.</p> : (
        <ul className="logs">{inbox.map((m) => (
          <li key={m.id}>
            <strong>{m.fromCall}</strong> <span className="muted">· {fmt.dateTime(m.postedAt)}</span>
            <span className="badge" style={{ marginLeft: 6 }}>{status(m)}</span>
            <div className="comment">{m.body}</div>
          </li>
        ))}</ul>
      ))}

      {tab === "bulletins" && (bulletins.length === 0 ? <p className="muted">No bulletins.</p> : (
        <ul className="logs">{bulletins.map((m) => (
          <li key={m.id}>
            <span className="badge">{m.toCall}</span> <strong>{m.fromCall}</strong>
            <span className="muted"> · {fmt.dateTime(m.postedAt)}</span>
            <div className="comment">{m.body}</div>
          </li>
        ))}</ul>
      ))}

      {tab === "compose" && (<>
        <label>To <span className="muted">(callsign, or ALL/BLN… for a bulletin)</span>
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="OE8APR" /></label>
        <label>Message <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={300} /></label>
        <div className="row end"><button className="primary" onClick={send}>Send</button></div>
        <p className="muted">From <strong>{props.callsign || "(set callsign)"}</strong>. Personal mail is held and store-and-forwarded over APRS when the recipient is next heard.</p>
      </>)}
      {msg && <p className="muted">{msg}</p>}
    </aside>
  );
}

// ----------------------------------------------------------------- top bar (cacher destinations)
function TopBar(props: {
  callsign: string; setCallsign: (v: string) => void; mode: Mode;
  onHide: () => void; onCancel: () => void; count: number; queued: number;
  onFilters: () => void; filtered: boolean;
  onNearby: () => void; onActivity: () => void; onProfile: () => void;
}) {
  return (
    <header className="topbar">
      <img className="logo" src={ASSET.wordmark} alt="APRScaching" />
      {props.mode === "view" && <button className={`icon${props.filtered ? " on" : ""}`} onClick={props.onFilters} title="Search & filter">⌕</button>}
      <span className="muted">· {props.count} caches{props.filtered ? " (filtered)" : " in view"}</span>
      {props.queued > 0 && <span className="muted" title="finds saved offline">· 📴 {props.queued} queued</span>}
      <span className="spacer" />
      <label className="call">
        callsign&nbsp;
        <input value={props.callsign} placeholder="OE8APR"
               onChange={(e) => props.setCallsign(e.target.value)} size={9} />
      </label>
      {props.mode === "view"
        ? <span className="nav-desktop">
            <button onClick={props.onNearby}>Nearby</button>
            <button onClick={props.onActivity}>Activity</button>
            <button onClick={props.onProfile} title="Profile — identity & advanced tools">👤</button>
            <button className="primary" onClick={props.onHide}>+ Hide a cache</button>
          </span>
        : <button onClick={props.onCancel}>Cancel</button>}
    </header>
  );
}

// ----------------------------------------------------------------- mobile bottom tab bar
function TabBar(props: {
  onMap: () => void; onNearby: () => void; onActivity: () => void; onProfile: () => void;
  onFab: () => void; fabLabel: string; active: string;
}) {
  const tab = (key: string, ic: string, label: string, onClick: () => void) => (
    <button className={props.active === key ? "on" : ""} onClick={onClick}>
      <span className="ic">{ic}</span><span>{label}</span>
    </button>
  );
  return (
    <nav className="tabbar">
      {tab("map", "🗺", "Map", props.onMap)}
      {tab("nearby", "📍", "Nearby", props.onNearby)}
      <button className="fab" onClick={props.onFab}>
        <span className="ic">{props.fabLabel === "Log" ? "✓" : "＋"}</span><span>{props.fabLabel}</span>
      </button>
      {tab("activity", "⚡", "Activity", props.onActivity)}
      {tab("profile", "👤", "You", props.onProfile)}
    </nav>
  );
}

// ----------------------------------------------------------------- Nearby (caches by distance)
function NearbyPanel(props: { caches: MapCache[]; map: maplibregl.Map | null; onPick: (id: number) => void; onClose: () => void }) {
  const fmt = useFmt();
  const c = props.map?.getCenter();
  const here = c ? { lat: c.lat, lon: c.lng } : null;
  const dist = (m: MapCache) => (here && m.lat != null && m.lon != null) ? haversine(here.lat, here.lon, m.lat, m.lon) : Infinity;
  const list = [...props.caches].filter((m) => m.lat != null && m.lon != null).sort((a, b) => dist(a) - dist(b)).slice(0, 100);
  return (
    <aside className="panel right">
      <div className="row between"><h2>Nearby</h2><button className="icon" onClick={props.onClose}>✕</button></div>
      <p className="muted">{list.length} caches, nearest first (from the map centre)</p>
      <ul className="board">
        {list.map((m) => {
          const meta = typeMeta(m.type);
          return (
            <li key={m.globalId} style={{ cursor: m.id != null ? "pointer" : "default" }} onClick={() => m.id != null && props.onPick(m.id)}>
              <span className="dot" style={{ background: meta.color }} />
              <span style={{ flex: 1 }}><span className="mono">{m.code}</span> <span className="muted">{m.title}</span></span>
              <span className="mono muted">{dist(m) === Infinity ? "" : fmt.distance(dist(m))}</span>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

// ----------------------------------------------------------------- Search & filter
function FilterPanel(props: { filters: { types: CacheType[]; q: string }; setFilters: (f: { types: CacheType[]; q: string }) => void; count: number; onClose: () => void }) {
  const { filters, setFilters } = props;
  const toggle = (t: CacheType) => setFilters({ ...filters, types: filters.types.includes(t) ? filters.types.filter((x) => x !== t) : [...filters.types, t] });
  return (
    <aside className="panel right">
      <div className="row between"><h2>⌕ Search &amp; filter</h2><button className="icon" onClick={props.onClose}>✕</button></div>
      <label>Search
        <input autoFocus value={filters.q} placeholder="code or title…" onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
      </label>
      <h4>Cache type</h4>
      <div className="badges">
        {TYPE_ORDER.map((t) => {
          const m = TYPE_META[t]; const on = filters.types.includes(t);
          return <button key={t} className={on ? "primary" : ""} style={{ borderRadius: 14, fontSize: 13 }} onClick={() => toggle(t)}>{m.glyph} {m.label}</button>;
        })}
      </div>
      <div className="row between" style={{ marginTop: 14 }}>
        <button className="link" onClick={() => setFilters({ types: [], q: "" })}>clear all</button>
        <span className="muted">{props.count} match{props.count === 1 ? "" : "es"}</span>
      </div>
    </aside>
  );
}

// ----------------------------------------------------------------- Activity (feed + leaderboard glance)
function ActivityPanel(props: { map: maplibregl.Map | null; onBoard: () => void; onClose: () => void }) {
  const fmt = useFmt();
  const [feed, setFeed] = useState<ActivityItem[]>([]);
  const [top, setTop] = useState<LeaderboardEntry[]>([]);
  useEffect(() => {
    const m = props.map; const bbox = m ? [m.getBounds().getWest(), m.getBounds().getSouth(), m.getBounds().getEast(), m.getBounds().getNorth()] as BBox : undefined;
    getActivity(bbox).then((r) => setFeed(r.activity)).catch(console.error);
    getLeaderboard(bbox ?? [-180, -90, 180, 90], "points").then((r) => setTop(r.leaderboard.slice(0, 5))).catch(console.error);
  }, [props.map]);
  return (
    <aside className="panel right">
      <div className="row between"><h2>Activity</h2><button className="icon" onClick={props.onClose}>✕</button></div>
      <h4>Recent finds</h4>
      {feed.length === 0 ? <p className="muted">No recent activity here.</p> : (
        <ul className="logs">
          {feed.map((a) => (
            <li key={a.id}>
              {a.logType === "found" && a.verified ? <span className={`badge tier${a.tier ?? "C"}`}>{a.tier === "A" ? "RF" : a.tier === "B" ? "App" : "✓"}</span> : <span className={`badge ${a.logType}`}>{a.logType}</span>}
              <strong className="mono">{a.loggerCall}</strong> <span className="muted">found</span> <span className="mono">{a.cacheCode}</span>
              <span className="muted"> · {fmt.ago(a.ts)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="row between"><h4>Top finders</h4><button className="link" onClick={props.onBoard}>full leaderboard →</button></div>
      <ol className="board">
        {top.map((e) => (
          <li key={e.loggerCall}><span className="rank">{e.rank}</span>
            <span className="mono" style={{ flex: 1 }}>{e.loggerCall}</span><strong>{e.points}</strong>&nbsp;<span className="muted">pts</span></li>
        ))}
      </ol>
    </aside>
  );
}

// ----------------------------------------------------------------- Profile (identity + the advanced door)
function ProfilePanel(props: {
  callsign: string; map: maplibregl.Map | null;
  onWorkbench: () => void; onMail: () => void; onSettings: () => void; onClose: () => void;
}) {
  const fmt = useFmt();
  const [profile, setProfile] = useState<Profile | null>(null);
  useEffect(() => {
    if (props.callsign.length >= 3) getProfile(props.callsign).then(setProfile).catch(console.error);
    else setProfile(null);
  }, [props.callsign]);
  return (
    <aside className="panel right">
      <div className="row between"><h2>👤 <span className="mono">{props.callsign || "Profile"}</span></h2><button className="icon" onClick={props.onClose}>✕</button></div>
      {props.callsign.length < 3 ? <p className="muted">Set your callsign in the top bar to claim your finds.</p> : (<>
        <p><span className="badge tierC">unverified account</span> <button className="link" title="Send an APRS message-challenge to your callsign (coming in the identity pass)">verify callsign</button></p>
        {profile && <p><strong>{profile.finds}</strong> finds · <strong>{profile.points}</strong> pts · <strong>{profile.hides}</strong> hidden
          {profile.lastFind && <span className="muted"> · last find {fmt.date(profile.lastFind)}</span>}</p>}
        {profile && profile.badges.length > 0 && (
          <div className="badges">{profile.badges.map((b) => <span key={b.badge} className="award">{b.badge}</span>)}</div>
        )}
        <label className="geo" style={{ marginTop: 10, opacity: .6 }}>
          <input type="checkbox" disabled style={{ width: "auto" }} /> &nbsp;Announce finds to APRS-IS
          <span className="muted">&nbsp;— verify your callsign first</span>
        </label>
      </>)}

      <h4>Advanced</h4>
      <p className="muted">The full APRS workbench — live stations, transports, digipeater, IGate, BBS, decoder. A cacher never needs this.</p>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button onClick={props.onWorkbench}>📡 Workbench</button>
        <button onClick={props.onMail}>✉ BBS</button>
        <button onClick={props.onSettings}>⚙ Settings</button>
      </div>
    </aside>
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
  const fmt = useFmt();
  const [fav, setFav] = useState({ on: c.favorited, count: c.favorites });
  useEffect(() => { setFav({ on: c.favorited, count: c.favorites }); }, [c.id, c.favorited, c.favorites]);
  async function toggleFav() {
    if (props.callsign.length < 3) return;
    const want = !fav.on;
    setFav((f) => ({ on: want, count: f.count + (want ? 1 : -1) })); // optimistic
    try { const r = await toggleFavorite(c.id, props.callsign, want); setFav(r); } catch { setFav({ on: c.favorited, count: c.favorites }); }
  }
  return (
    <aside className="panel right">
      <div className="row between">
        <h2><span className="dot" style={{ background: meta.color }} /> <span className="code">{c.code}</span></h2>
        <span className="spacer" />
        <button className={`heart${fav.on ? " on" : ""}`} title="Favorite" onClick={toggleFav}>{fav.on ? "♥" : "♡"} {fav.count}</button>
        <button className="icon" onClick={props.onClose}>✕</button>
      </div>
      <h3>{c.title}</h3>
      <p className="muted">
        {meta.label} · D {c.difficulty.toFixed(1)} / T {c.terrain.toFixed(1)} · by {c.ownerCall}
        {c.minTrust && <> · requires tier {c.minTrust}</>}
      </p>
      {c.source !== "native" && (
        <p className="imported">
          ⤓ Imported from <strong>{c.sourceName ?? c.source}</strong>
          {c.sourceUrl && <> · <a href={c.sourceUrl} target="_blank" rel="noreferrer noopener">view source ↗</a></>}
        </p>
      )}
      <p><strong>{c.finds}</strong> verified find{c.finds === 1 ? "" : "s"}
        {c.status !== "active" && <> · <em>{c.status}</em></>}
        {c.needsMaintenance && <span className="warn"> · ⚠ needs maintenance</span>}</p>
      {c.description && <p>{c.description}</p>}
      {c.hint && <details><summary>Hint</summary><p>{c.hint}</p></details>}

      {c.stageCount > 0 && <StagesSection cacheId={c.id} callsign={props.callsign} />}

      <LogForm cacheId={c.id} cacheCode={c.code} callsign={props.callsign} onLogged={props.onLogged} />

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
            {l.corroboratedBy && <span className="muted"> · ⇄ via {l.corroboratedBy}</span>}
            <span className="muted"> · {fmt.date(l.ts)}</span>
            {l.comment && <div className="comment">{l.comment}</div>}
          </li>
        ))}
      </ul>
    </aside>
  );
}

// ----------------------------------------------------------------- audio-cache stages (finder view)
function StagesSection(props: { cacheId: number; callsign: string }) {
  const fmt = useFmt();
  const [stages, setStages] = useState<CacheStage[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    getStages(props.cacheId, props.callsign || undefined).then((r) => setStages(r.stages)).catch(console.error);
  }, [props.cacheId, props.callsign]);
  useEffect(() => { load(); }, [load]);

  async function reveal(stageNo: number) {
    if (props.callsign.length < 3) { setErr("Set your callsign first."); return; }
    setBusy(stageNo); setErr(null);
    const finish = async (appGeo?: AppGeo) => {
      try {
        const r = await unlockStage(props.cacheId, stageNo, props.callsign, appGeo);
        if (r.unlocked) load();
        else setErr(r.reason === "too_far" ? `Too far — ${fmt.distance(r.distanceM ?? 0)} away.` : "Not unlocked yet.");
      } catch (e) { setErr((e as Error).message); }
      finally { setBusy(null); }
    };
    // geo stages need your live position; open/audio stages just unlock on request
    const stage = stages.find((s) => s.stageNo === stageNo);
    if (stage?.unlock === "geo" && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => finish({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracyM: pos.coords.accuracy, ts: Math.floor(Date.now() / 1000) }),
        () => { setErr("Location permission needed to unlock this stage."); setBusy(null); },
        { enableHighAccuracy: true, timeout: 10000 },
      );
    } else { finish(); }
  }

  // the next actionable (locked) stage
  const nextLocked = stages.find((s) => s.stageNo > 0 && !s.unlocked);
  return (
    <div className="stages">
      <h4>Stages <span className="muted" style={{ fontWeight: 400 }}>· {stages.filter((s) => s.unlocked).length}/{stages.length} unlocked</span></h4>
      <ol className="stagelist">
        {stages.map((s) => (
          <li key={s.stageNo} className={s.unlocked ? "open" : "locked"}>
            <div className="row between">
              <strong>{s.stageNo === 0 ? "Start" : `Stage ${s.stageNo}`}</strong>
              <span className="muted">{s.unlocked ? "✓ unlocked" : `🔒 ${s.unlock}`}</span>
            </div>
            {s.clue && <div className="comment">{s.clue}</div>}
            {s.mediaUrl && <audio controls preload="none" src={mediaUrl(s.mediaUrl)} style={{ width: "100%", marginTop: 6 }} />}
            {s.unlocked && s.lat != null && s.lon != null && (
              <div className="muted" style={{ marginTop: 4 }}>
                📍 <span className="mono">{fmt.coord(s.lat, s.lon)}</span> · <a href={`https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}#map=17/${s.lat}/${s.lon}`} target="_blank" rel="noreferrer noopener">map ↗</a>
              </div>
            )}
            {!s.unlocked && nextLocked?.stageNo === s.stageNo && (
              <button className="primary" style={{ marginTop: 6 }} disabled={busy === s.stageNo} onClick={() => reveal(s.stageNo)}>
                {busy === s.stageNo ? "Checking…" : s.unlock === "geo" ? "I'm here — reveal" : "Reveal next stage"}
              </button>
            )}
          </li>
        ))}
      </ol>
      {err && <p className="error">{err}</p>}
    </div>
  );
}

// ----------------------------------------------------------------- one-tap log (the core action)
function LogForm(props: { cacheId: number; cacheCode: string; callsign: string; onLogged: () => void }) {
  const fmt = useFmt();
  const [busy, setBusy] = useState<LogType | null>(null);
  const [result, setResult] = useState<LogResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");

  // request the device fix (Tier-B path); resolve undefined if denied/unavailable so the tap still succeeds
  function getGeo(): Promise<AppGeo | undefined> {
    if (!navigator.geolocation) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracyM: p.coords.accuracy ?? 9999, ts: Math.floor(p.timestamp / 1000) }),
        () => resolve(undefined),
        { enableHighAccuracy: true, timeout: 8000 },
      );
    });
  }

  async function doLog(logType: LogType, comment?: string) {
    if (props.callsign.length < 3) { setErr("Set your callsign in the top bar first."); return; }
    setBusy(logType); setErr(null);
    try {
      const appGeo = logType === "found" ? await getGeo() : undefined;
      let author;
      try {
        const instance = await getInstance();
        if (instance) {
          const at = Math.floor(Date.now() / 1000);
          author = await signAuthorship({ cache: props.cacheCode, instance, logger: props.callsign, logType, at });
          if (author) await registerKey({ callsign: props.callsign, publicKey: author.authorKey }).catch(() => {});
        }
      } catch { /* unsupported browser -> log unsigned */ }
      const r = await logFind(props.cacheId, { loggerCall: props.callsign, logType, comment, appGeo, author });
      setResult(r); setNote(""); setNoteOpen(false); props.onLogged();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(null); }
  }

  // the trust badge IS the feedback, shown after the tap (tap it for the "why")
  function tierBadge(r: LogResult) {
    if (r.logType !== "found") return null;
    if (!r.verified) return <span className="badge tierC" title={r.reason ?? ""}>Logged · unverified</span>;
    const label = r.tier === "A" ? "RF" : r.tier === "B" ? "App" : String(r.tier);
    const why = `Tier ${r.tier} · ${r.method ?? ""}${r.distanceM != null ? ` · ${fmt.distance(r.distanceM)}` : ""}${r.corroboratedBy ? ` · via ${r.corroboratedBy}` : ""}`;
    return <span className={`badge tier${r.tier}`} title={why}>Verified · {label}</span>;
  }

  if (result) {
    const verb = result.logType === "found" ? "Logged" : result.logType === "dnf" ? "Marked DNF" : "Note posted";
    return (
      <div className="logresult">
        <div className="big">{result.queued ? "Saved" : verb} {result.logType === "found" && result.verified ? "✓" : ""}</div>
        {result.queued
          ? <div className="muted" style={{ marginTop: 4 }}>📴 offline — will sync when you're back online</div>
          : <div className="tier">{tierBadge(result)}</div>}
        {result.announced && <div className="muted" style={{ marginTop: 4 }}>announced to APRS-IS</div>}
        {result.signerKey && <div className="muted">signed with your device key ✍</div>}
        {result.logType === "found" && (noteOpen ? (
          <div style={{ marginTop: 8 }}>
            <textarea rows={2} placeholder="Add a note…" value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="row end"><button disabled={busy === "note" || !note.trim()} onClick={() => doLog("note", note.trim())}>Post</button></div>
          </div>
        ) : <button className="link" style={{ marginTop: 8 }} onClick={() => setNoteOpen(true)}>add a note</button>)}
        <div style={{ marginTop: 8 }}><button className="link" onClick={() => { setResult(null); setNote(""); setNoteOpen(false); }}>log again</button></div>
      </div>
    );
  }

  return (
    <div className="logform">
      <button className="primary" style={{ width: "100%", fontSize: 16, padding: "11px" }} disabled={!!busy} onClick={() => doLog("found")}>
        {busy === "found" ? "Logging…" : "✓ Log a find"}
      </button>
      <div className="row between" style={{ marginTop: 8 }}>
        <button className="link" disabled={!!busy} onClick={() => doLog("dnf")}>{busy === "dnf" ? "…" : "Couldn't find it"}</button>
        <button className="link" onClick={() => setNoteOpen((v) => !v)}>Add a note</button>
      </div>
      {noteOpen && (
        <div style={{ marginTop: 6 }}>
          <textarea rows={2} placeholder="Note…" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="row end"><button disabled={busy === "note" || !note.trim()} onClick={() => doLog("note", note.trim())}>Post note</button></div>
        </div>
      )}
      {err && <p className="error">{err}</p>}
    </div>
  );
}
