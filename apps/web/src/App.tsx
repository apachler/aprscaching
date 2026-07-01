import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import {
  listCaches, getCache, getStations, getSpots, resolveView, API_BASE, flushLogQueue, queuedLogCount, getProfile, adminWhoami,
  type CacheSummary, type CacheDetail, type MapCache, type BBox, type StationSummary, type Spot, type MapViewState,
  type SearchHitCache, type SearchHitStation,
} from "./api.js";
import { TopBar } from "./TopBar.js";
import { ToastProvider, Icon, Tour, tourSeen, type TourStep } from "./ui/index.js";
import { Landing } from "./Landing.js";
import type { GeofencePrompt } from "@aprsweb/shared";
import { surfaceByView } from "@aprsweb/shared";
import { typeMeta } from "./cacheTypes.js";
import { roleMeta } from "./stationRoles.js";
import { aprsGlyph } from "./aprsGlyph.js";
import { ASSET } from "./brand.js";
import { buildGraticuleStyle } from "./offlineBasemap.js";
import {
  FormatContext, makeFormatters, loadSettings, saveSettings, resolveTheme, type LocaleSettings,
} from "./format.js";
import { pullPrefs, notePrefChange, PREFS_EVENT } from "./prefs.js";
import type { CacheType } from "@aprsweb/shared";
import type { StyleSpecification } from "maplibre-gl";
import { useSession } from "./identity/useSession.js";
import { SignIn } from "./identity/SignIn.js";
import { maidenhead, gridCenter, haversine } from "./map/geo.js";
import { toMgrs } from "@aprsweb/aprs";
import { MapTools } from "./map/MapTools.js";
import { BasemapSwitcher } from "./map/BasemapSwitcher.js";
import { NavRail } from "./NavRail.js";
import { SettingsPanel } from "./identity/SettingsPanel.js";
import { AdminPanel } from "./identity/AdminPanel.js";
import { NearbyPanel } from "./caches/NearbyPanel.js";
import { FilterPanel } from "./caches/FilterPanel.js";
import { HidePanel } from "./caches/HidePanel.js";
import { DetailPanel } from "./caches/DetailPanel.js";
import { SpotCard } from "./live/SpotCard.js";
import { RemoteCachePanel } from "./caches/RemoteCachePanel.js";
import { ActivityPanel } from "./activity/ActivityPanel.js";
import { CommunityPanel } from "./activity/CommunityPanel.js";
import { ProfilePanel } from "./profile/ProfilePanel.js";
import { WorkbenchPanel } from "./workbench/WorkbenchPanel.js";
import { WorkbenchAppSurface } from "./workbench/WorkbenchAppSurface.js";
import { MessagesPanel } from "./messages/MessagesPanel.js";
import { StationPanel } from "./stations/StationPanel.js";
import { WORKBENCH_APPS, usePinnedApps, appById, type WorkbenchAppId, type WorkbenchApp } from "./workbench/apps.js";

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
  // Callback-ref node (not a plain ref): the map must initialise exactly when its container mounts.
  // If `active` is already true on first render (a returning explorer / signed-in user reloading, where
  // sessionStorage/session make `active` true before the app subtree mounts), an effect keyed only on
  // `active` would run once while the container is still absent and never re-run — leaving a blank map.
  const [mapNode, setMapNode] = useState<HTMLDivElement | null>(null);
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
  const [wbApp, setWbApp] = useState<WorkbenchAppId | null>(null); // the launched workbench app surface (its own workspace)
  const { pins, toggle: togglePin } = usePinnedApps();
  const [showNearby, setShowNearby] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [showMessages, setShowMessages] = useState(false);
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
  // live activity spots (docs/20 S2) — opt-in overlay, off by default like raster layers
  const [spotsOn, setSpotsOn] = useState(false);
  const [spots, setSpots] = useState<Spot[]>([]);
  const [pickedSpot, setPickedSpot] = useState<Spot | null>(null);
  const spotsOnRef = useRef(spotsOn);
  useEffect(() => { spotsOnRef.current = spotsOn; }, [spotsOn]);
  const [spotFilters, setSpotFilters] = useState<{ bands: string[]; modes: string[]; sources: string[] }>({ bands: [], modes: [], sources: [] });
  const spotFiltersRef = useRef(spotFilters);
  useEffect(() => { spotFiltersRef.current = spotFilters; }, [spotFilters]);
  const [locSettings, setLocSettings] = useState<LocaleSettings>(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [sysop, setSysop] = useState(false);              // signed-in account is this instance's operator
  const [center, setCenter] = useState<[number, number] | null>(null); // map centre, for the coord readout
  const fmt = useMemo(() => makeFormatters(locSettings), [locSettings]);
  const applySettings = useCallback((s: LocaleSettings) => { setLocSettings(s); saveSettings(s); notePrefChange(); }, []);

  // Account UI-prefs sync (docs/13): on sign-in, pull the account's theme/units/pins/basemap and
  // apply them locally; PREFS_EVENT fires if anything changed so live settings re-read. Guests are
  // untouched (the endpoint is session-gated). localStorage stays the source of truth.
  useEffect(() => { if (session.signedIn) void pullPrefs(); }, [session.signedIn]);
  // Instance-operator (sysop) check — reveals the admin surface only for the ham who deployed this instance.
  useEffect(() => {
    if (!session.signedIn) { setSysop(false); return; }
    adminWhoami().then((r) => setSysop(!!r.sysop)).catch(() => setSysop(false));
  }, [session.signedIn]);
  useEffect(() => {
    const onSync = () => setLocSettings(loadSettings());
    window.addEventListener(PREFS_EVENT, onSync);
    return () => window.removeEventListener(PREFS_EVENT, onSync);
  }, []);

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
    setShowBoard(false); setShowWB(false); setWbApp(null); setShowNearby(false);
    setShowActivity(false); setShowMessages(false); setShowProfile(false); setShowSettings(false); setShowAdmin(false); setShowSignIn(false);
    setShowFilter(false);
    // Also leave "hide a cache" mode — navigating anywhere (rail/tab/map) must dismiss the hide form
    // and its draft marker, not leave it stuck on top of the destination panel.
    setMode("view"); setDraft(null);
    draftMarker.current?.remove(); draftMarker.current = null;
    setSelectedId(null); setRemote(null); setPickedStation(null);
  }, []);
  const openOnly = useCallback((open: () => void) => { closeAll(); open(); }, [closeAll]);
  // Launch a workbench app: EVERY app opens its own dedicated surface (WorkbenchAppSurface). Used by
  // the workbench launcher and the pinned rail items.
  // Operator-only apps (NET/ROM node, remote box) drive the instance's server RF box — refuse to open them
  // for non-operators even by deep link. Field-station apps (terminal/BBS/decoder/tools/rig) are open to all.
  const launchApp = useCallback((id: WorkbenchAppId) => {
    if (appById(id)?.sysop && !sysop) return;
    openOnly(() => setWbApp(id));
  }, [openOnly, sysop]);
  const visibleApps = useMemo(() => WORKBENCH_APPS.filter((a) => sysop || !a.sysop), [sysop]);

  // Navigate to a surface by its manifest key (Site map rows + ?view= deep-links share this).
  const navigate = useCallback((key: string) => {
    const opener: Record<string, () => void> = {
      map: () => {}, nearby: () => setShowNearby(true), filter: () => setShowFilter(true),
      hide: () => startHide(), activity: () => setShowActivity(true), ranks: () => setShowBoard(true),
      messages: () => setShowMessages(true),
      workbench: () => setShowWB(true), bbs: () => setWbApp("bbs"), terminal: () => setWbApp("terminal"),
      profile: () => setShowProfile(true), settings: () => setShowSettings(true),
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

  // capture / restore a shareable map view (docs/11 M1)
  const getViewState = useCallback((): MapViewState => {
    const c = map.current?.getCenter();
    return {
      center: c ? [c.lng, c.lat] : undefined, zoom: map.current?.getZoom(),
      layers: { spots: spotsOn, stations: stationsOn },
      filters, spotFilters, selected: selectedId,
    };
  }, [spotsOn, stationsOn, filters, spotFilters, selectedId]);
  const applyView = useCallback((s: MapViewState) => {
    if (s.center && s.zoom != null) map.current?.flyTo({ center: s.center, zoom: s.zoom });
    if (s.layers) { setSpotsOn(!!s.layers.spots); setStationsOn(!!s.layers.stations); }
    if (s.filters) setFilters(s.filters as typeof filters);
    if (s.spotFilters) setSpotFilters(s.spotFilters);
    if (s.selected != null) openOnly(() => setSelectedId(s.selected!));
  }, [openOnly]); // eslint-disable-line react-hooks/exhaustive-deps
  const viewLinked = useRef(false);
  useEffect(() => {
    if (viewLinked.current || !active || !ready) return;
    viewLinked.current = true;
    try {
      const slug = new URLSearchParams(window.location.search).get("v");
      if (slug) resolveView(slug).then((r) => applyView(r.state)).catch(() => {});
    } catch { /* ignore */ }
  }, [active, ready, applyView]);

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
  const spotMarkers = useRef<Map<string, maplibregl.Marker>>(new Map());
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
    if (spotsOnRef.current) {
      try { setSpots((await getSpots(bbox, spotFiltersRef.current)).spots); } catch (e) { console.error(e); }
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
    if (!active || !mapNode || map.current) return;
    const m = new maplibregl.Map({
      container: mapNode, style: STYLE, center: DEFAULT_CENTER, zoom: 9, hash: true,
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
  }, [refresh, active, mapNode]);

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
        btn.onclick = (ev) => { ev.stopPropagation(); openOnly(() => setPickedStation(s.callsign)); };
        mk = new maplibregl.Marker({ element: btn, anchor: "center" }).setLngLat([s.lon, s.lat]).addTo(m);
        stationMarkers.current.set(s.callsign, mk);
      } else {
        mk.setLngLat([s.lon, s.lat]);
      }
      const el = mk.getElement();
      const role = roleMeta(s.roles);
      // Glyph precedence: station role → the station's own APRS symbol → moving/idle dot.
      const aprs = role ? null : aprsGlyph(s.symbol);
      const label = role ? role.label : aprs?.label;
      el.title = `${s.callsign}${label ? ` · ${label}` : ""}${s.comment ? ` — ${s.comment}` : ""}`;
      el.classList.toggle("role", !!role);
      el.style.background = role ? role.color : "";
      el.style.color = role ? "#0d141a" : "";
      const moving = s.course != null && !!s.speedKn;
      const span = el.querySelector("span") as HTMLElement;
      span.textContent = role ? role.glyph : aprs ? aprs.glyph : moving ? "➤" : "•";
      // only the bare directional dot rotates with course; a concrete symbol glyph stays upright
      span.style.transform = !role && !aprs && moving ? `rotate(${(s.course ?? 0) - 90}deg)` : "";
    }
    for (const [cs, mk] of stationMarkers.current) {
      if (!seen.has(cs)) { mk.remove(); stationMarkers.current.delete(cs); }
    }
  }, [stations, stationsOn]);

  // ---- live activity-spots layer (docs/20 S2): opt-in overlay, distinct marker class ----
  useEffect(() => {
    if (spotsOn) { refresh(); }
    else { for (const [, mk] of spotMarkers.current) mk.remove(); spotMarkers.current.clear(); setSpots([]); setPickedSpot(null); }
  }, [spotsOn, refresh]);

  // re-query spots when the band/mode/source filters change (while the layer is on)
  useEffect(() => { if (spotsOn) refresh(); }, [spotFilters]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const m = map.current; if (!m) return;
    if (!spotsOn) return;
    const seen = new Set<string>();
    for (const s of spots) {
      seen.add(s.id);
      let mk = spotMarkers.current.get(s.id);
      if (!mk) {
        const btn = document.createElement("button");
        btn.className = "spot-pin";
        btn.innerHTML = "<span>◎</span>";
        btn.onclick = (ev) => { ev.stopPropagation(); setPickedSpot(s); };
        mk = new maplibregl.Marker({ element: btn, anchor: "center" }).setLngLat([s.lon, s.lat]).addTo(m);
        spotMarkers.current.set(s.id, mk);
      } else {
        mk.setLngLat([s.lon, s.lat]);
      }
      mk.getElement().title = `${s.callsign}${s.ref ? ` @ ${s.ref}` : ""}${s.band ? ` · ${s.band}` : ""}${s.mode ? ` ${s.mode}` : ""}`;
    }
    for (const [id, mk] of spotMarkers.current) {
      if (!seen.has(id)) { mk.remove(); spotMarkers.current.delete(id); }
    }
  }, [spots, spotsOn]);

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

  // home QTH (from your profile locator) — feeds the MapTools bearing arc to the selected cache
  const [home, setHome] = useState<[number, number] | null>(null);
  useEffect(() => {
    if (!callsign) { setHome(null); return; }
    let live = true;
    getProfile(callsign)
      .then((p) => { if (live) setHome(p.profile?.homeGrid ? gridCenter(p.profile.homeGrid) : null); })
      .catch(() => { if (live) setHome(null); });
    return () => { live = false; };
  }, [callsign]);
  const target: [number, number] | null = detail && detail.lat != null && detail.lon != null ? [detail.lat, detail.lon] : null;

  // in the 3-pane shell the map is a flex child — resize MapLibre when a dock opens/closes
  const leftOpen = showNearby || showActivity || showMessages || showProfile || showFilter || showBoard || showWB || wbApp != null || pickedStation != null || showSettings || mode === "hide";
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

  // enriched-search picks: a cache opens its detail + flies there; a station just flies to it
  function pickCacheHit(hit: SearchHitCache) {
    setFilters((f) => ({ ...f, q: "" }));
    setRemote(null);
    openOnly(() => setSelectedId(hit.id));
    if (hit.lat != null && hit.lon != null) map.current?.flyTo({ center: [hit.lon, hit.lat], zoom: Math.max(map.current.getZoom(), 14) });
  }
  function pickStationHit(hit: SearchHitStation) {
    setFilters((f) => ({ ...f, q: "" }));
    if (hit.lat != null && hit.lon != null) map.current?.flyTo({ center: [hit.lon, hit.lat], zoom: Math.max(map.current.getZoom(), 12) });
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
      <TopBar callsign={callsign} verified={verified} onAccount={() => openOnly(() => (session.signedIn ? setShowSettings(true) : setShowSignIn(true)))}
              onHide={startHide} count={shown.length} queued={queued}
              onFilters={() => openOnly(() => setShowFilter(true))}
              filtered={filters.types.length > 0 || filters.q.length > 0}
              q={filters.q} onSearch={(v) => setFilters({ ...filters, q: v })} onSearchSubmit={runSearch}
              onPickCache={pickCacheHit} onPickStation={pickStationHit}
              onNearby={() => openOnly(() => setShowNearby(true))}
              onActivity={() => openOnly(() => setShowActivity(true))}
              onProfile={() => openOnly(() => setShowProfile(true))}
              sysop={sysop} onAdmin={() => openOnly(() => setShowAdmin(true))} />
      <div className="shell">
        <NavRail
          active={showNearby ? "nearby" : showActivity ? "activity" : showMessages ? "messages" : showBoard ? "ranks" : wbApp ? wbApp : showWB ? "workbench" : showProfile ? "profile" : showSettings ? "settings" : "map"}
          onMap={closeAll}
          onNearby={() => openOnly(() => setShowNearby(true))}
          onActivity={() => openOnly(() => setShowActivity(true))}
          onMessages={() => openOnly(() => setShowMessages(true))}
          onRanks={() => openOnly(() => setShowBoard(true))}
          onWorkbench={() => openOnly(() => setShowWB(true))}
          onProfile={() => openOnly(() => setShowProfile(true))}
          onSettings={() => openOnly(() => setShowSettings(true))}
          pinnedApps={pins.map(appById).filter((a): a is WorkbenchApp => !!a && (sysop || !a.sysop))}
          onLaunchApp={launchApp} />

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
        {showMessages && mode === "view" && (
          <MessagesPanel callsign={callsign} onClose={() => setShowMessages(false)} />
        )}
        {showFilter && mode === "view" && (
          <FilterPanel filters={filters} setFilters={setFilters} count={shown.length}
            includeUnvetted={includeUnvetted} setIncludeUnvetted={setIncludeUnvetted}
            spotsOn={spotsOn} setSpotsOn={setSpotsOn} stationsOn={stationsOn} setStationsOn={setStationsOn}
            spotFilters={spotFilters} setSpotFilters={setSpotFilters}
            getViewState={getViewState} onClose={() => setShowFilter(false)} />
        )}
        {showProfile && mode === "view" && (
          <ProfilePanel callsign={callsign} map={map.current}
                        onWorkbench={() => openOnly(() => setShowWB(true))}
                        onMail={() => launchApp("bbs")}
                        onSettings={() => openOnly(() => setShowSettings(true))}
                        onClose={() => setShowProfile(false)} />
        )}
        {showBoard && mode === "view" && (
          <CommunityPanel map={map.current} onClose={() => setShowBoard(false)} />
        )}
        {showWB && mode === "view" && (
          <WorkbenchPanel onClose={() => setShowWB(false)}
                          apps={visibleApps} pinned={pins} onLaunchApp={launchApp} onTogglePin={togglePin} />
        )}
        {wbApp && mode === "view" && (
          <WorkbenchAppSurface app={wbApp} callsign={callsign} verified={verified} map={map.current} onClose={() => setWbApp(null)} />
        )}
        {pickedStation && mode === "view" && (
          <StationPanel callsign={callsign} picked={pickedStation} map={map.current}
                        onFly={(lat, lon) => map.current?.flyTo({ center: [lon, lat], zoom: Math.max(map.current.getZoom(), 12) })}
                        onClose={() => setPickedStation(null)} />
        )}
        {showSignIn && (
          <SignIn onDone={() => { session.refresh(); setShowSignIn(false); }} onClose={() => setShowSignIn(false)} />
        )}
        {showSettings && (
          <SettingsPanel settings={locSettings} onApply={applySettings} callsign={callsign} verified={verified}
                         map={map.current} onFly={(lat, lon) => map.current?.flyTo({ center: [lon, lat], zoom: Math.max(map.current.getZoom(), 12) })}
                         session={session} onSignIn={() => openOnly(() => setShowSignIn(true))} onClose={() => setShowSettings(false)} />
        )}
        {showAdmin && sysop && mode === "view" && (
          <AdminPanel callsign={callsign} map={map.current} onClose={() => setShowAdmin(false)} />
        )}

        <div className="mapwrap">
          <div ref={setMapNode} className="map" />
          {ready && center && (
            <div className="coordreadout">
              <div><div className="crl">Lat / Lon</div><div className="crv">{center[0].toFixed(4)}° {center[1].toFixed(4)}°</div></div>
              <div><div className="crl">Grid</div><div className="crv">{maidenhead(center[0], center[1])}</div></div>
              <div><div className="crl">MGRS</div><div className="crv">{toMgrs(center[0], center[1], 4) || "—"}</div></div>
            </div>
          )}
          {ready && <BasemapSwitcher map={map.current} />}
          {ready && <MapTools map={map.current} home={home} target={target} />}
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
          {pickedSpot && mode === "view" && (
            <SpotCard spot={pickedSpot} onClose={() => setPickedSpot(null)}
              onViewCache={(() => {
                const c = caches.find((c) => c.id != null && c.lat != null && c.lon != null && haversine(pickedSpot.lat, pickedSpot.lon, c.lat, c.lon) <= 300);
                return c ? () => { setRemote(null); setSelectedId(c.id!); setPickedSpot(null); } : undefined;
              })()} />
          )}
        </div>

        {/* right-dock: cache detail / mirrored cache — docked right at ≥1024px (coexists with a left panel) */}
        {detail && mode === "view" && !remote && !showBoard && (
          <DetailPanel detail={detail} callsign={callsign}
                       activating={detail.lat != null && detail.lon != null
                         ? spots.find((s) => haversine(s.lat, s.lon, detail.lat!, detail.lon!) <= 300) ?? null : null}
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
