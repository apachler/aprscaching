import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import {
  listCaches, getCache, getStations, API_BASE, flushLogQueue, queuedLogCount,
  type CacheSummary, type CacheDetail, type MapCache, type BBox, type StationSummary,
} from "./api.js";
import { ToastProvider, Icon, Tour, tourSeen, type TourStep } from "./ui/index.js";
import { Landing } from "./Landing.js";
import type { GeofencePrompt } from "@aprsweb/shared";
import { surfaceByView } from "@aprsweb/shared";
import { typeMeta } from "./cacheTypes.js";
import { ASSET } from "./brand.js";
import { buildGraticuleStyle } from "./offlineBasemap.js";
import {
  FormatContext, makeFormatters, loadSettings, saveSettings, resolveTheme, type LocaleSettings,
} from "./format.js";
import type { CacheType } from "@aprsweb/shared";
import type { StyleSpecification } from "maplibre-gl";
import { useSession } from "./identity/useSession.js";
import { SignIn } from "./identity/SignIn.js";
import { maidenhead, gridCenter } from "./map/geo.js";
import { NavRail } from "./NavRail.js";
import { SettingsPanel } from "./identity/SettingsPanel.js";
import { NearbyPanel } from "./caches/NearbyPanel.js";
import { FilterPanel } from "./caches/FilterPanel.js";
import { HidePanel } from "./caches/HidePanel.js";
import { DetailPanel } from "./caches/DetailPanel.js";
import { RemoteCachePanel } from "./caches/RemoteCachePanel.js";
import { ActivityPanel } from "./activity/ActivityPanel.js";
import { CommunityPanel } from "./activity/CommunityPanel.js";
import { ProfilePanel } from "./profile/ProfilePanel.js";
import { SiteMapPanel } from "./SiteMapPanel.js";
import { WorkbenchPanel } from "./workbench/WorkbenchPanel.js";
import { MailPanel } from "./live/MailPanel.js";

const DEFAULT_CENTER: [number, number] = [15.42, 47.07]; // Graz, OE
// keyless online basemap by default; `VITE_BASEMAP=offline` uses the self-contained grid.
const STYLE: string | StyleSpecification =
  import.meta.env.VITE_BASEMAP === "offline"
    ? buildGraticuleStyle()
    : "https://demotiles.maplibre.org/style.json";

type Mode = "view" | "hide";

// Quick-tour steps are config-driven and DEFERRED to the content pass (docs/18) — one neutral
// placeholder so the framework is live and testable without committing copy.
const TOUR_STEPS: TourStep[] = [
  { title: "Quick tour", body: "Guided tour coming soon. For now you're browsing in read-only mode — explore the map and caches freely. Sign in to log finds, hide caches, and unlock the workbench." },
];

export function App() {
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const markers = useRef<Map<string, maplibregl.Marker>>(new Map());
  const draftMarker = useRef<maplibregl.Marker | null>(null);
  const modeRef = useRef<Mode>("view");
  const debounce = useRef<ReturnType<typeof setTimeout>>();

  const session = useSession();
  const callsign = session.callsign;
  const verified = session.verified;
  const [showSignIn, setShowSignIn] = useState(false);
  // landing gate (docs/18): signed-in skips the landing; signed-out sees it until they Explore
  // (per-session intent) or sign in. The platform is the same SPA in read-only when signed out.
  const [explored, setExplored] = useState(() => { try { return sessionStorage.getItem("acs.explore") === "1"; } catch { return false; } });
  const [tourOpen, setTourOpen] = useState(false);
  const active = session.signedIn || explored;
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
  // T3.1: include caches mirrored from UNVETTED (auto-discovered) peers — off by default (ui-ux §2)
  const [includeUnvetted, setIncludeUnvetted] = useState(false);
  const includeUnvettedRef = useRef(includeUnvetted);
  includeUnvettedRef.current = includeUnvetted;
  const [stationsOn, setStationsOn] = useState(false);
  const [stations, setStations] = useState<StationSummary[]>([]);
  const [pickedStation, setPickedStation] = useState<string | null>(null);
  const [locSettings, setLocSettings] = useState<LocaleSettings>(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [showSiteMap, setShowSiteMap] = useState(false);
  const [center, setCenter] = useState<[number, number] | null>(null); // map centre, for the coord readout
  const fmt = useMemo(() => makeFormatters(locSettings), [locSettings]);
  const applySettings = useCallback((s: LocaleSettings) => { setLocSettings(s); saveSettings(s); }, []);

  // operator 3-pane mode (≥1024px): side panels dock and the cache detail coexists with a left panel
  const [op, setOp] = useState(() => window.matchMedia?.("(min-width: 1024px)").matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.("(min-width: 1024px)"); if (!mq) return;
    const h = () => setOp(mq.matches); mq.addEventListener("change", h); return () => mq.removeEventListener("change", h);
  }, []);

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
    setShowActivity(false); setShowProfile(false); setShowSettings(false); setShowSignIn(false);
    setShowFilter(false); setShowSiteMap(false);
    setSelectedId(null); setRemote(null);
  }, []);
  const openOnly = useCallback((open: () => void) => { closeAll(); open(); }, [closeAll]);

  // Navigate to a surface by its manifest key (Site map rows + ?view= deep-links share this).
  const navigate = useCallback((key: string) => {
    const opener: Record<string, () => void> = {
      map: () => {}, nearby: () => setShowNearby(true), filter: () => setShowFilter(true),
      hide: () => startHide(), activity: () => setShowActivity(true), ranks: () => setShowBoard(true),
      workbench: () => setShowWB(true), bbs: () => setShowMail(true), profile: () => setShowProfile(true),
      settings: () => setShowSettings(true), sitemap: () => setShowSiteMap(true),
    };
    openOnly(() => opener[key]?.());
  }, [openOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  // One-shot ?view= deep-link, used by the Site map and sitemap.xml/api consumers. The map position
  // stays in MapLibre's #z/lat/lon hash, so this query param never collides with it.
  const deepLinked = useRef(false);
  useEffect(() => {
    if (deepLinked.current || !active) return;
    deepLinked.current = true;
    try {
      const view = new URLSearchParams(window.location.search).get("view");
      const s = view ? surfaceByView(view) : null;
      if (s) navigate(s.key);
    } catch { /* ignore */ }
  }, [active, navigate]);

  // Explore → drop into the read-only platform for this session; run the tour once (first time).
  const onExplore = useCallback(() => {
    try { sessionStorage.setItem("acs.explore", "1"); } catch { /* ignore */ }
    setExplored(true);
    if (!tourSeen()) setTourOpen(true);
  }, []);
  // Signing out returns to the landing (clears the per-session explore intent).
  const prevSignedIn = useRef(session.signedIn);
  useEffect(() => {
    if (prevSignedIn.current && !session.signedIn) {
      try { sessionStorage.removeItem("acs.explore"); } catch { /* ignore */ }
      setExplored(false);
    }
    prevSignedIn.current = session.signedIn;
  }, [session.signedIn]);

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
    try { setCaches((await listCaches(bbox, includeUnvettedRef.current)).caches); }
    catch (e) { console.error(e); }
    finally { setReady(true); }
    if (stationsOnRef.current) {
      try { setStations((await getStations(bbox)).stations); } catch (e) { console.error(e); }
    }
  }, [subscribeLive]);

  // re-fetch the map when the unvetted-network toggle flips (T3.1)
  useEffect(() => { refresh(); }, [includeUnvetted, refresh]);

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
    if (!active) return;
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
  }, [subscribeLive, active]);

  // re-subscribe when the callsign changes so prompts are addressed to you
  useEffect(() => {
    const m = map.current; if (!m) return;
    const b = m.getBounds();
    subscribeLive([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
  }, [callsign, subscribeLive]);

  // ---- init map once ----
  useEffect(() => {
    if (!active || !mapEl.current || map.current) return;
    const m = new maplibregl.Map({
      container: mapEl.current, style: STYLE, center: DEFAULT_CENTER, zoom: 9, hash: true,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    m.addControl(new maplibregl.GeolocateControl({ trackUserLocation: true }), "top-left");
    map.current = m;

    const trackCenter = () => setCenter([m.getCenter().lat, m.getCenter().lng]);
    m.on("load", () => { trackCenter(); refresh(); });
    m.on("moveend", () => {
      trackCenter();
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
  }, [refresh, active]);

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

  // in the 3-pane shell the map is a flex child — resize MapLibre when a dock opens/closes
  const leftOpen = showNearby || showActivity || showProfile || showFilter || showBoard || showWB || showMail || showSettings || showSiteMap || mode === "hide";
  const rightOpen = (detail != null && !remote) || remote != null;
  useEffect(() => {
    const t = setTimeout(() => map.current?.resize(), 60);
    return () => clearTimeout(t);
  }, [op, leftOpen, rightOpen]);

  // global search: a Maidenhead locator or "lat, lon" flies the map there; otherwise filter by text
  function runSearch(raw: string) {
    const q = raw.trim();
    const g = gridCenter(q);
    if (g) { map.current?.flyTo({ center: [g[1], g[0]], zoom: Math.max(map.current.getZoom(), 10) }); return; }
    const ll = q.match(/^(-?\d+(?:\.\d+)?)\s*[ ,]\s*(-?\d+(?:\.\d+)?)$/);
    if (ll) {
      const lat = +ll[1]!, lon = +ll[2]!;
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) map.current?.flyTo({ center: [lon, lat], zoom: Math.max(map.current.getZoom(), 12) });
    }
  }

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
    <ToastProvider>
    {session.loading ? (
      <div className="splash"><img src={ASSET.wordmark} alt="APRScaching" /></div>
    ) : !active ? (
      <>
        <Landing onRegister={() => setShowSignIn(true)} onLogin={() => setShowSignIn(true)} onExplore={onExplore} />
        {showSignIn && (
          <SignIn onDone={() => { session.refresh(); setShowSignIn(false); }} onClose={() => setShowSignIn(false)} />
        )}
      </>
    ) : (
    <div className="app">
      <TopBar callsign={callsign} verified={verified} onAccount={() => openOnly(() => (session.signedIn ? setShowSettings(true) : setShowSignIn(true)))} mode={mode}
              onHide={startHide} onCancel={cancelHide} count={shown.length} queued={queued}
              onFilters={() => openOnly(() => setShowFilter(true))}
              filtered={filters.types.length > 0 || filters.q.length > 0}
              q={filters.q} onSearch={(v) => setFilters({ ...filters, q: v })} onSearchSubmit={runSearch}
              onNearby={() => openOnly(() => setShowNearby(true))}
              onActivity={() => openOnly(() => setShowActivity(true))}
              onProfile={() => openOnly(() => setShowProfile(true))} />
      <div className="shell">
        <NavRail
          active={showNearby ? "nearby" : showActivity ? "activity" : showBoard ? "ranks" : showWB ? "workbench" : showMail ? "bbs" : showProfile ? "profile" : showSettings ? "settings" : "map"}
          onMap={closeAll}
          onNearby={() => openOnly(() => setShowNearby(true))}
          onActivity={() => openOnly(() => setShowActivity(true))}
          onRanks={() => openOnly(() => setShowBoard(true))}
          onWorkbench={() => openOnly(() => setShowWB(true))}
          onMail={() => openOnly(() => setShowMail(true))}
          onProfile={() => openOnly(() => setShowProfile(true))}
          onSettings={() => openOnly(() => setShowSettings(true))} />

        {/* left-dock panels (single-overlay among themselves) — docked left at ≥1024px */}
        {mode === "hide" && (
          <HidePanel callsign={callsign} draft={draft} onCancel={cancelHide} onCreated={onCreated} />
        )}
        {showNearby && mode === "view" && (
          <NearbyPanel caches={shown} stations={stations} map={map.current} selectedId={selectedId}
                       onPick={(id) => { if (op) { setRemote(null); setSelectedId(id); } else openOnly(() => setSelectedId(id)); }}
                       onClose={() => setShowNearby(false)} />
        )}
        {showActivity && mode === "view" && (
          <ActivityPanel map={map.current} onBoard={() => openOnly(() => setShowBoard(true))} onClose={() => setShowActivity(false)} />
        )}
        {showFilter && mode === "view" && (
          <FilterPanel filters={filters} setFilters={setFilters} count={shown.length}
            includeUnvetted={includeUnvetted} setIncludeUnvetted={setIncludeUnvetted} onClose={() => setShowFilter(false)} />
        )}
        {showProfile && mode === "view" && (
          <ProfilePanel callsign={callsign} map={map.current}
                        onWorkbench={() => openOnly(() => setShowWB(true))}
                        onMail={() => openOnly(() => setShowMail(true))}
                        onSettings={() => openOnly(() => setShowSettings(true))}
                        onSiteMap={() => openOnly(() => setShowSiteMap(true))}
                        onClose={() => setShowProfile(false)} />
        )}
        {showSiteMap && mode === "view" && (
          <SiteMapPanel callsign={callsign} onNavigate={navigate} onClose={() => setShowSiteMap(false)} />
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
        {showMail && mode === "view" && (
          <MailPanel callsign={callsign} onClose={() => setShowMail(false)} />
        )}
        {showSignIn && (
          <SignIn onDone={() => { session.refresh(); setShowSignIn(false); }} onClose={() => setShowSignIn(false)} />
        )}
        {showSettings && (
          <SettingsPanel settings={locSettings} onApply={applySettings} callsign={callsign}
                         session={session} onSignIn={() => openOnly(() => setShowSignIn(true))} onClose={() => setShowSettings(false)} />
        )}

        <div className="mapwrap">
          <div ref={mapEl} className="map" />
          {ready && center && (
            <div className="coordreadout">
              <div><div className="crl">Lat / Lon</div><div className="crv">{center[0].toFixed(4)}° {center[1].toFixed(4)}°</div></div>
              <div><div className="crl">Grid</div><div className="crv">{maidenhead(center[0], center[1])}</div></div>
            </div>
          )}
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
        </div>

        {/* right-dock: cache detail / mirrored cache — docked right at ≥1024px (coexists with a left panel) */}
        {detail && mode === "view" && !remote && !showBoard && (
          <DetailPanel detail={detail} callsign={callsign}
                       onClose={() => setSelectedId(null)} onLogged={reloadDetail} />
        )}
        {remote && mode === "view" && !showBoard && (
          <RemoteCachePanel cache={remote} onClose={() => setRemote(null)} />
        )}
      </div>

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
      {tourOpen && <Tour steps={TOUR_STEPS} onDone={() => setTourOpen(false)} />}
    </div>
    )}
    </ToastProvider>
    </FormatContext.Provider>
  );
}

// ----------------------------------------------------------------- top bar (cacher destinations)
function TopBar(props: {
  callsign: string; verified: boolean; onAccount: () => void; mode: Mode;
  onHide: () => void; onCancel: () => void; count: number; queued: number;
  onFilters: () => void; filtered: boolean;
  q: string; onSearch: (v: string) => void; onSearchSubmit: (v: string) => void;
  onNearby: () => void; onActivity: () => void; onProfile: () => void;
}) {
  return (
    <header className="topbar">
      <img className="logo" src={ASSET.wordmark} alt="APRScaching" />
      {props.mode === "view" && <button className={`icon filter-ic${props.filtered ? " on" : ""}`} onClick={props.onFilters} title="Filter by type">⌕</button>}
      {props.mode === "view" && (
        <label className="topsearch">
          <Icon name="search" size={16} />
          <input value={props.q} placeholder="Search callsign, cache id, or grid…" aria-label="Search caches"
                 onChange={(e) => props.onSearch(e.target.value)}
                 onKeyDown={(e) => { if (e.key === "Enter") props.onSearchSubmit(props.q); }} />
        </label>
      )}
      <span className="muted">· {props.count} caches{props.filtered ? " (filtered)" : " in view"}</span>
      {props.queued > 0 && <span className="muted" title="finds saved offline">· 📴 {props.queued} queued</span>}
      <span className="spacer" />
      <button className={`idchip${props.verified ? " ok" : ""}`} onClick={props.onAccount} title="Account & callsigns">
        {props.callsign
          ? <><span className="mono">{props.callsign}</span>{props.verified ? <Icon name="check" size={14} /> : <span className="idchip-x">unverified</span>}</>
          : <><Icon name="profile" size={15} /> Sign in</>}
      </button>
      {props.mode === "view"
        ? <>
            <span className="nav-desktop">
              <button onClick={props.onNearby}>Nearby</button>
              <button onClick={props.onActivity}>Activity</button>
              <button onClick={props.onProfile} title="Profile — identity & advanced tools">👤</button>
            </span>
            <button className="primary hide-cta" onClick={props.onHide}>+ Hide a cache</button>
          </>
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
