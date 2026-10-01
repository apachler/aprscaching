// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState, useCallback, useMemo, lazy, Suspense } from "react";
import * as maplibregl from "maplibre-gl";
import "./styles/vendor/maplibre.css";
import "./styles/index.css";
import {
  listCaches,
  getCache,
  getStations,
  getMeshcomNodes,
  getMeshcomLinks,
  getSpots,
  resolveView,
  getProfile,
  adminWhoami,
  type CacheSummary,
  type CacheDetail,
  type MapCache,
  type BBox,
  type StationSummary,
  type MeshcomNode,
  type MeshcomLink,
  type Spot,
  type MapViewState,
  type SearchHitCache,
  type SearchHitStation,
} from "./api.js";
import { TopBar } from "./TopBar.js";
import { Tour, TOUR_STEPS, Button, useToast, Icon } from "./ui/index.js";
import type { GeofencePrompt } from "@aprscaching/shared";
import { ASSET, MAP_MARKER } from "./brand.js";
import { buildGraticuleStyle, buildPackTileStyle, buildPhosphorStyle } from "./offlineBasemap.js";
import { packTilesSummary, registerPackTiles } from "./offline/packTiles.js";
import { FormatContext, makeFormatters, loadSettings, saveSettings, type LocaleSettings } from "./format.js";
import { applyTheme, watchSystemTheme } from "./shell/theme.js";
import { pullPrefs, notePrefChange, PREFS_EVENT } from "./prefs.js";
import { setToolTxVerified, feedHeard } from "./tools/host.js";
import { ToolMapLayers } from "./tools/ToolMapLayers.js";
import type { CacheType } from "@aprscaching/shared";
import { DEFAULT_BASEMAP_STYLE } from "@aprscaching/shared";
import type { StyleSpecification } from "maplibre-gl";
import type { SessionState } from "./identity/useSession.js";
import { SignIn } from "./identity/SignIn.js";
import { maidenhead, gridCenter, haversine, parseCoordinates } from "./map/geo.js";
import { toMgrs } from "@aprscaching/aprs";
import { MapTools } from "./map/MapTools.js";
import { LocateControl } from "./map/LocateControl.js";
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
import { OutboxPanel } from "./log/OutboxPanel.js";
import { OfflinePanel } from "./offline/OfflinePanel.js";
import type { OfflineSource } from "./offline/packs.js";
import { offlineReady, type OfflineFrom } from "./api.js";

// offline packs' map tiles answer acs-pack:// requests (offline/packTiles.ts)
registerPackTiles(offlineReady);
import { CommunityPanel } from "./activity/CommunityPanel.js";
import { ProfilePanel } from "./profile/ProfilePanel.js";
import { ShackPanel } from "./shack/ShackPanel.js";
import { ShackAppSurface } from "./shack/ShackAppSurface.js";
import { MessagesPanel } from "./messages/MessagesPanel.js";
import { StationPanel } from "./stations/StationPanel.js";
import { SHACK_APPS, usePinnedApps, appById, type ShackApp } from "./shack/apps.js";
import {
  MAP,
  NAV_ITEMS,
  TAB_ITEMS,
  activeKey,
  createViewHistory,
  panel,
  viewFromQuery,
  viewOf,
  type PanelKey,
  type View,
} from "./nav.js";
import { PlatformContext } from "./platform/PlatformContext.js";
import { TabBar } from "./platform/TabBar.js";
import { useLiveSocket } from "./platform/useLiveSocket.js";
import { useSync } from "./platform/useSync.js";
import { useMapInstance, mapHash } from "./platform/useMapInstance.js";
import { NO_WEBGL_TEXT, fallbackBbox } from "./platform/mapSupport.js";
import { useCacheMarkers, useStationMarkers, useSpotMarkers, useMeshcomMarkers } from "./platform/markerLayers.js";
import { MeshcomLinks } from "./meshcom/MeshcomLinks.js";
// The manual reader carries the whole bundled docs tree — lazy-load it so it never weighs on the map.
const DocsPanel = lazy(() => import("./docs/DocsPanel.js").then((m) => ({ default: m.DocsPanel })));

const DEFAULT_CENTER: [number, number] = [15.42, 47.07]; // Graz, OE
// Keyless online basemap by default: OpenFreeMap's OSM vector tiles (free, no key, no usage caps —
// a volunteer-run service, so the offline graticule and the VITE_BASEMAP_STYLE override are the
// fallbacks). `VITE_BASEMAP=offline` uses the self-contained grid; `VITE_BASEMAP_STYLE` points an
// instance at any MapLibre style URL (self-hosted tiles, a commercial provider).
const STYLE: string | StyleSpecification =
  import.meta.env.VITE_BASEMAP === "offline"
    ? buildGraticuleStyle()
    : ((import.meta.env.VITE_BASEMAP_STYLE as string | undefined) ?? DEFAULT_BASEMAP_STYLE);

/** The base map style for the active theme: Phosphor always uses its keyless phosphor graticule so the
 *  map matches the terminal chrome; Modern uses the configured basemap. */
const baseStyle = (): string | StyleSpecification =>
  document.documentElement.dataset.theme === "phosphor"
    ? buildPhosphorStyle()
    : // without a connection a remote style cannot load: start on the self-contained grid
      typeof STYLE === "string" && !navigator.onLine
      ? buildGraticuleStyle()
      : STYLE;

const NONE: never[] = []; // a layer that is off draws no markers
/** localStorage key remembering the live-stations layer switch in this browser. */
const STATIONS_KEY = "acs.layer.stations";
/** The MeshCom layer (on unless switched off) and its links (off unless switched on), per browser. */
const MESHCOM_KEY = "acs.layer.meshcom";
const MESHCOM_LINKS_KEY = "acs.layer.meshcomLinks";

/** A remembered layer switch; `fallback` when this browser never set it or storage is blocked. */
function useLayerPref(key: string, fallback: boolean) {
  const [on, setOn] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : v === "1";
    } catch {
      return fallback;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, on ? "1" : "0");
    } catch {
      // storage blocked (private window): the layer resets on reload
    }
  }, [key, on]);
  return [on, setOn] as const;
}

const bboxOf = (m: maplibregl.Map): BBox => {
  const b = m.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
};

/** Drop (or move) the draggable hide-a-cache pin at lat/lon; dragging it updates the draft. */
function placeDraftPin(
  m: maplibregl.Map,
  marker: { current: maplibregl.Marker | null },
  setDraft: (d: { lat: number; lon: number }) => void,
  lat: number,
  lon: number,
) {
  setDraft({ lat, lon });
  marker.current?.remove();
  marker.current = new maplibregl.Marker({ color: MAP_MARKER.draft, draggable: true }).setLngLat([lon, lat]).addTo(m);
  marker.current.on("dragend", () => {
    const ll = marker.current!.getLngLat();
    setDraft({ lat: +ll.lat.toFixed(6), lon: +ll.wrap().lng.toFixed(6) });
  });
}

/**
 * Platform — the signed-in / explore shack: the MapLibre map plus every panel. Lazily imported by
 * `App` so the signed-out marketing landing never downloads maplibre-gl (~1 MB) or this map code.
 * It mounts only when `active` (signed in or exploring), so `active` is constant-true within.
 *
 * One `View` (nav.ts) says which left-dock surface is open; the cache detail on the right is separate
 * (`selectedId` / `remote`) because it coexists with a left panel on wide screens. The session and the
 * map reach the surfaces through PlatformContext.
 */
export default function Platform({ session, startTour }: { session: SessionState; startTour: boolean }) {
  const [mapNode, setMapNode] = useState<HTMLDivElement | null>(null);
  const toast = useToast();
  const draftMarker = useRef<maplibregl.Marker | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const callsign = session.callsign;
  const verified = session.verified;
  // Keep the shared Tool host's TX gate in sync with the session so a tool's beacon/TX stays
  // gated on callsign control-verification.
  useEffect(() => {
    setToolTxVerified(verified);
  }, [verified]);
  const [view, setView] = useState<View>(MAP);
  const isPanel = (key: PanelKey) => view.kind === "panel" && view.key === key;
  const hiding = isPanel("hide");
  const [tourOpen, setTourOpen] = useState(startTour);
  const [caches, setCaches] = useState<MapCache[]>([]);
  const [draft, setDraft] = useState<{ lat: number; lon: number } | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<CacheDetail | null>(null);
  // offline: where the map's caches and the open cache page came from (an offline pack)
  const [offlineMap, setOfflineMap] = useState<{ source: OfflineSource | null } | null>(null);
  const [detailFrom, setDetailFrom] = useState<OfflineFrom | null>(null);
  const [remote, setRemote] = useState<MapCache | null>(null); // a mirrored (peer) cache, read-only
  const [ready, setReady] = useState(false);
  const [nearPrompt, setNearPrompt] = useState<GeofencePrompt | null>(null);
  const { pins, toggle: togglePin } = usePinnedApps();
  const [filters, setFilters] = useState<{ types: CacheType[]; q: string }>({ types: [], q: "" });
  // include caches mirrored from UNVETTED (auto-discovered) peers — off by default (ui-ux §2)
  const [includeUnvetted, setIncludeUnvetted] = useState(false);
  const includeUnvettedRef = useRef(includeUnvetted);
  includeUnvettedRef.current = includeUnvetted;
  // The live-stations layer stays opt-in; once turned on, this browser remembers it across reloads.
  const [stationsOn, setStationsOn] = useState(() => {
    try {
      return localStorage.getItem(STATIONS_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(STATIONS_KEY, stationsOn ? "1" : "0");
    } catch {
      // storage blocked (private window): the layer simply resets on reload
    }
  }, [stationsOn]);
  const [stations, setStations] = useState<StationSummary[]>([]);
  // MeshCom: nodes on the map by default where the instance has any; links only when asked for
  const [meshcomOn, setMeshcomOn] = useLayerPref(MESHCOM_KEY, true);
  const [meshcomLinksOn, setMeshcomLinksOn] = useLayerPref(MESHCOM_LINKS_KEY, false);
  const [meshcomNodes, setMeshcomNodes] = useState<MeshcomNode[]>([]);
  const [meshcomLinks, setMeshcomLinks] = useState<MeshcomLink[]>([]);
  const meshcomRef = useRef({ on: meshcomOn, links: meshcomLinksOn });
  meshcomRef.current = { on: meshcomOn, links: meshcomLinksOn };
  // live activity spots — opt-in overlay, off by default like raster layers
  const [spotsOn, setSpotsOn] = useState(false);
  const [spots, setSpots] = useState<Spot[]>([]);
  const [pickedSpot, setPickedSpot] = useState<Spot | null>(null);
  const spotsOnRef = useRef(spotsOn);
  useEffect(() => {
    spotsOnRef.current = spotsOn;
  }, [spotsOn]);
  const [spotFilters, setSpotFilters] = useState<{ bands: string[]; modes: string[]; sources: string[] }>({
    bands: [],
    modes: [],
    sources: [],
  });
  const spotFiltersRef = useRef(spotFilters);
  useEffect(() => {
    spotFiltersRef.current = spotFilters;
  }, [spotFilters]);
  const [locSettings, setLocSettings] = useState<LocaleSettings>(loadSettings);
  const [docSlug, setDocSlug] = useState("index"); // deep-link seed for the manual reader
  const [sysop, setSysop] = useState(false); // signed-in account is this instance's operator
  const [sysopKnown, setSysopKnown] = useState(false); // the operator check has answered (or nobody is signed in)
  const sysopRef = useRef(sysop);
  sysopRef.current = sysop;
  const [operatorPending, setOperatorPending] = useState(false); // operator's call not yet confirmed
  const [center, setCenter] = useState<[number, number] | null>(null); // map centre, for the coord readout
  const [here, setHere] = useState<{ lat: number; lon: number } | null>(null); // the viewer, once located
  const fmt = useMemo(() => makeFormatters(locSettings), [locSettings]);
  const applySettings = useCallback((s: LocaleSettings) => {
    setLocSettings(s);
    saveSettings(s);
    notePrefChange();
  }, []);

  // Account UI-prefs sync: on sign-in, pull the account's theme/units/pins/basemap and
  // apply them locally; PREFS_EVENT fires if anything changed so live settings re-read. Guests are
  // untouched (the endpoint is session-gated). localStorage stays the source of truth.
  useEffect(() => {
    if (session.signedIn) void pullPrefs();
  }, [session.signedIn]);
  // Instance-operator (sysop) check — reveals the admin surface only for the ham who deployed this instance.
  useEffect(() => {
    if (!session.signedIn) {
      setSysop(false);
      setOperatorPending(false);
      setSysopKnown(true);
      return;
    }
    adminWhoami()
      .then((r) => {
        setSysop(!!r.sysop);
        setOperatorPending(r.pending === "verify");
      })
      .catch(() => {
        setSysop(false);
        setOperatorPending(false);
      })
      .finally(() => setSysopKnown(true));
    // re-asked when the call's verification changes: the operator confirms it from the CLI, then re-checks
  }, [session.signedIn, session.verified]);
  useEffect(() => {
    const onSync = () => setLocSettings(loadSettings());
    window.addEventListener(PREFS_EVENT, onSync);
    return () => window.removeEventListener(PREFS_EVENT, onSync);
  }, []);

  // operator 3-pane mode (≥1024px): side panels dock and the cache detail coexists with a left panel
  const [op, setOp] = useState(() => window.matchMedia?.("(min-width: 1024px)").matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.("(min-width: 1024px)");
    if (!mq) return;
    const h = () => setOp(mq.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, []);

  // apply the theme to the document root (shell/theme.ts), and follow the system's colour scheme while the
  // Appearance setting is "auto"; data-crt gates the opt-in scanline/glow overlay (Phosphor only)
  useEffect(() => {
    applyTheme(locSettings);
    return watchSystemTheme(locSettings);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- applyTheme reads only .theme/.crt, both listed
  }, [locSettings.theme, locSettings.crt]);

  const callsignRef = useRef(callsign);
  useEffect(() => {
    callsignRef.current = callsign;
  }, [callsign]);
  const stationsOnRef = useRef(stationsOn);
  useEffect(() => {
    stationsOnRef.current = stationsOn;
  }, [stationsOn]);

  // ---- navigation ----
  // Open a view: the one left-dock surface, closing the cache detail. Opening MAP closes everything.
  // Operator-only destinations (the admin surface, the NET/ROM node and remote box, which drive the
  // instance's server RF box) are refused for non-operators even by deep link; hiding a cache needs a
  // sign-in first, so a signed-out visitor does not fill the whole form only to fail at submit.
  const openView = useCallback(
    (v: View) => {
      if (v.kind === "app" && appById(v.id)?.sysop && !sysopRef.current) return;
      if (v.kind === "panel" && v.key === "admin" && !sysopRef.current) return;
      if (v.kind === "panel" && v.key === "hide" && callsignRef.current.length < 3) {
        toast("Sign in to hide a cache.");
        v = panel("signin");
      }
      setView(v);
      setSelectedId(null);
      setRemote(null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toast identity is stable (context push)
    [],
  );
  const closeAll = useCallback(() => openView(MAP), [openView]);
  /** Close the left-dock surface only; an open cache detail stays. */
  const closeView = useCallback(() => setView(MAP), []);
  const launchApp = useCallback((id: ShackApp["id"]) => openView({ kind: "app", id }), [openView]);
  const visibleApps = useMemo(() => SHACK_APPS.filter((a) => sysop || !a.sysop), [sysop]);
  const openCache = useCallback((id: number) => {
    setRemote(null);
    setSelectedId(id);
  }, []);

  // Leaving "hide a cache" (for any destination) drops its draft marker, so it never stays stuck on
  // top of the next panel.
  useEffect(() => {
    if (hiding) return;
    setDraft(null);
    draftMarker.current?.remove();
    draftMarker.current = null;
  }, [hiding]);

  // ---- the map ----
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const { map, mapRef, mapFailed } = useMapInstance(
    mapNode,
    { style: baseStyle, fallbackStyle: buildGraticuleStyle, center: DEFAULT_CENTER, zoom: 9 },
    {
      onLoad: (m) => {
        setCenter([m.getCenter().lat, m.getCenter().lng]);
        void refreshRef.current();
      },
      onMoveEnd: (m) => {
        setCenter([m.getCenter().lat, m.getCenter().lng]);
        clearTimeout(debounce.current);
        debounce.current = setTimeout(() => void refreshRef.current(), 250);
      },
      onClick: (m, e) => {
        if (!hiding) return;
        placeDraftPin(m, draftMarker, setDraft, +e.lngLat.lat.toFixed(6), +e.lngLat.wrap().lng.toFixed(6));
      },
    },
  );
  const flyTo = useCallback(
    (lat: number, lon: number, minZoom: number) =>
      mapRef.current?.flyTo({ center: [lon, lat], zoom: Math.max(mapRef.current.getZoom(), minZoom) }),
    [mapRef],
  );

  // swap the MapLibre base style when the theme changes (init already picks the right one). DOM
  // markers are overlays, not style layers, so they survive setStyle. But the style-LAYER overlays
  // (grid/rings/terminator/arc, the raster basemap, tracks) ARE wiped by setStyle, so `styleEpoch`
  // bumps once the new style settles — the overlay owners key their setup on it and re-add. The mount
  // run is skipped: the map was just created with the right style.
  // Dark, light and auto share one basemap; only Phosphor has its own.
  const phosphorStyle = locSettings.theme === "phosphor";
  const themeAtMount = useRef(phosphorStyle);
  const [styleEpoch, setStyleEpoch] = useState(0);
  useEffect(() => {
    const m = mapRef.current;
    if (!m || themeAtMount.current === phosphorStyle) {
      themeAtMount.current = phosphorStyle;
      return;
    }
    themeAtMount.current = phosphorStyle;
    m.setStyle(baseStyle());
    styleKind.current = "base";
    m.once("idle", () => setStyleEpoch((e) => e + 1)); // idle (not styledata) → no setData feedback loop
  }, [phosphorStyle, mapRef]);

  // Offline, the map draws the packs' tiles when any pack holds them (else the grid stays); back online,
  // the configured basemap returns. Overlays re-add themselves on the style epoch, as on a theme switch.
  const styleKind = useRef<"base" | "packs">("base");
  const showingOffline = offlineMap != null;
  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    let live = true;
    void (async () => {
      let next: StyleSpecification | string | null = null;
      if (showingOffline && styleKind.current === "base") {
        const tiles = await packTilesSummary(await offlineReady());
        if (tiles) next = buildPackTileStyle(tiles.maxZoom, tiles.attribution);
      } else if (!showingOffline && styleKind.current === "packs") next = baseStyle();
      if (!live || !next) return;
      styleKind.current = showingOffline ? "packs" : "base";
      m.setStyle(next);
      m.once("idle", () => setStyleEpoch((e) => e + 1));
    })();
    return () => {
      live = false;
    };
  }, [showingOffline, mapRef]);

  // ---- browser history: the back button closes what is open (see nav.ts createViewHistory) ----
  // The deep link is read at mount, before the first sync rewrites the query.
  const [initialQuery] = useState(() => window.location.search);
  const viewHistory = useRef<ReturnType<typeof createViewHistory> | null>(null);
  useEffect(() => {
    const h = createViewHistory(
      window,
      (v) => openView(v),
      () => (mapRef.current ? mapHash(mapRef.current) : null),
    );
    viewHistory.current = h;
    return () => {
      h.dispose();
      viewHistory.current = null;
    };
  }, [openView, mapRef]);
  const anythingOpen = view.kind !== "map" || selectedId != null || remote != null;
  useEffect(() => {
    viewHistory.current?.sync(view, anythingOpen);
  }, [view, anythingOpen]);

  // One-shot ?view= deep link (the Site map, sitemap.xml and API consumers link these). The map
  // position stays in MapLibre's #z/lat/lon hash, so this query param never collides with it.
  // An operator-only destination waits for the operator check, which answers after the first render.
  const deepLinked = useRef(false);
  useEffect(() => {
    if (deepLinked.current) return;
    const v = viewFromQuery(initialQuery);
    const operatorOnly =
      v && ((v.kind === "panel" && v.key === "admin") || (v.kind === "app" && !!appById(v.id)?.sysop));
    if (operatorOnly && !sysopKnown) return;
    deepLinked.current = true;
    if (!v) return;
    if (v.kind === "panel" && v.key === "docs") setDocSlug(new URLSearchParams(initialQuery).get("doc") || "index");
    openView(v);
  }, [initialQuery, openView, sysopKnown]);

  // capture / restore a shareable map view
  const getViewState = useCallback((): MapViewState => {
    const c = mapRef.current?.getCenter();
    return {
      center: c ? [c.lng, c.lat] : undefined,
      zoom: mapRef.current?.getZoom(),
      layers: { spots: spotsOn, stations: stationsOn, meshcom: meshcomOn, meshcomLinks: meshcomLinksOn },
      filters,
      spotFilters,
      selected: selectedId,
    };
  }, [spotsOn, stationsOn, meshcomOn, meshcomLinksOn, filters, spotFilters, selectedId, mapRef]);
  const applyView = useCallback(
    (s: MapViewState) => {
      if (s.center && s.zoom != null) mapRef.current?.flyTo({ center: s.center, zoom: s.zoom });
      if (s.layers) {
        setSpotsOn(!!s.layers.spots);
        setStationsOn(!!s.layers.stations);
        if (s.layers.meshcom !== undefined) setMeshcomOn(!!s.layers.meshcom);
        if (s.layers.meshcomLinks !== undefined) setMeshcomLinksOn(!!s.layers.meshcomLinks);
      }
      if (s.filters) setFilters(s.filters as typeof filters);
      if (s.spotFilters) setSpotFilters(s.spotFilters);
      if (s.selected != null) {
        closeAll();
        setSelectedId(s.selected);
      }
    },
    [closeAll, mapRef, setMeshcomOn, setMeshcomLinksOn],
  );
  const viewLinked = useRef(false);
  useEffect(() => {
    if (viewLinked.current || !ready) return;
    viewLinked.current = true;
    try {
      const slug = new URLSearchParams(initialQuery).get("v");
      if (slug)
        resolveView(slug)
          .then((r) => applyView(r.state))
          .catch(() => {});
    } catch {
      /* ignore */
    }
  }, [ready, applyView, initialQuery]);

  // caches that pass the active filters (type + text) — drives the markers, Nearby and the count
  const shown = useMemo(
    () =>
      caches.filter(
        (c) =>
          (filters.types.length === 0 || filters.types.includes(c.type)) &&
          (!filters.q || `${c.code} ${c.title ?? ""}`.toLowerCase().includes(filters.q.toLowerCase())),
      ),
    [caches, filters],
  );

  // ---- live socket: geofence prompts + live station deltas, subscribed to the viewport + callsign ----
  const { send } = useLiveSocket({
    onOpen: (sendNow) => {
      const m = mapRef.current;
      if (m)
        sendNow({ type: "subscribe", bbox: bboxOf(m), maxAgeSec: 3600, callsign: callsignRef.current || undefined });
    },
    onMessage: (raw) => {
      const msg = raw as { type?: string } & Record<string, unknown>;
      if (msg.type === "near_cache") setNearPrompt(msg as unknown as GeofencePrompt);
      else if (msg.type === "station" && meshcomRef.current.on) {
        // a MeshCom node that moved follows its live position; its details refresh with the map
        const st = msg as unknown as StationSummary;
        setMeshcomNodes((prev) =>
          prev.some((n) => n.callsign === st.callsign)
            ? prev.map((n) =>
                n.callsign === st.callsign ? { ...n, lat: st.lat, lon: st.lon, lastHeard: st.lastSeen } : n,
              )
            : prev,
        );
      }
      if (msg.type === "station" && stationsOnRef.current) {
        const st = msg as unknown as StationSummary;
        setStations((prev) => {
          const next = prev.filter((p) => p.callsign !== st.callsign);
          next.unshift({
            callsign: st.callsign,
            lat: st.lat,
            lon: st.lon,
            symbol: st.symbol ?? null,
            course: st.course ?? null,
            speedKn: null,
            altitudeM: null,
            comment: null,
            lastSeen: st.lastSeen,
          });
          return next.slice(0, 500);
        });
      }
    },
  });
  const subscribeLive = useCallback(
    (bbox: BBox) => send({ type: "subscribe", bbox, maxAgeSec: 3600, callsign: callsignRef.current || undefined }),
    [send],
  );

  const refresh = useCallback(async () => {
    const m = mapRef.current;
    if (!m && !mapFailed) return;
    const bbox = m ? bboxOf(m) : fallbackBbox(location.hash, DEFAULT_CENTER);
    subscribeLive(bbox);
    try {
      const r = await listCaches(bbox, includeUnvettedRef.current);
      setCaches(r.caches);
      setOfflineMap(r.offline ? { source: r.source ?? null } : null);
    } catch (e) {
      console.error(e);
    } finally {
      setReady(true);
    }
    if (stationsOnRef.current) {
      try {
        setStations((await getStations(bbox)).stations);
      } catch (e) {
        console.error(e);
      }
    }
    if (meshcomRef.current.on) {
      try {
        setMeshcomNodes((await getMeshcomNodes(bbox)).nodes);
        if (meshcomRef.current.links) setMeshcomLinks((await getMeshcomLinks(bbox)).links);
      } catch (e) {
        console.error(e);
      }
    }
    if (spotsOnRef.current) {
      try {
        setSpots((await getSpots(bbox, spotFiltersRef.current)).spots);
      } catch (e) {
        console.error(e);
      }
    }
  }, [subscribeLive, mapRef, mapFailed]);
  refreshRef.current = refresh;

  // re-fetch the map when the unvetted-network toggle flips
  useEffect(() => {
    void refresh();
  }, [includeUnvetted, refresh]);

  // logs queued while offline flush on load, whenever connectivity returns, and as backoffs come due
  const sync = useSync(() => void refresh());

  // re-subscribe when the callsign changes so prompts are addressed to you
  useEffect(() => {
    const m = mapRef.current;
    if (m) subscribeLive(bboxOf(m));
  }, [callsign, subscribeLive, mapRef]);

  // ---- map markers: caches, live stations and activity spots (platform/markerLayers.ts) ----
  const phosphor = locSettings.theme === "phosphor";
  useCacheMarkers(map, shown, phosphor, (c) => {
    if (c.mirrored) {
      setSelectedId(null);
      setRemote(c);
    } else if (c.id != null) openCache(c.id);
  });
  // a MeshCom node draws once, as a MeshCom pin, while that layer is on
  const meshcomCalls = useMemo(() => new Set(meshcomNodes.map((n) => n.callsign)), [meshcomNodes]);
  const stationPins = useMemo(
    () => (!stationsOn ? NONE : meshcomOn ? stations.filter((s) => !meshcomCalls.has(s.callsign)) : stations),
    [stationsOn, meshcomOn, stations, meshcomCalls],
  );
  useStationMarkers(map, stationPins, phosphor, (call) => openView({ kind: "station", call }));
  useMeshcomMarkers(map, meshcomOn ? meshcomNodes : NONE, phosphor, (call) => openView({ kind: "station", call }));
  useSpotMarkers(map, spotsOn ? spots : NONE, setPickedSpot);

  // ---- MeshCom layer and its links (toggled from Search & filter) ----
  useEffect(() => {
    if (!meshcomOn) setMeshcomNodes([]);
    if (!meshcomOn || !meshcomLinksOn) setMeshcomLinks([]);
    if (meshcomOn) void refresh();
  }, [meshcomOn, meshcomLinksOn, refresh]);

  // ---- live APRS stations layer (toggled from Search & filter) ----
  useEffect(() => {
    if (stationsOn) {
      void refresh();
    } else {
      setStations([]);
      setView((v) => (v.kind === "station" ? MAP : v));
    }
  }, [stationsOn, refresh]);

  // ---- feed heard callsigns from the live APRS layer into the tool host ----
  // mheard/watch-alert are source-agnostic: the packet terminal feeds "RF", this feeds "APRS". A
  // per-callsign lastSeen cursor avoids re-dispatching the same beacon on every refresh.
  const fedStations = useRef(new Map<string, number>());
  useEffect(() => {
    for (const s of stations) {
      const prev = fedStations.current.get(s.callsign) ?? 0;
      if (s.lastSeen > prev) {
        fedStations.current.set(s.callsign, s.lastSeen);
        feedHeard(s.callsign, "APRS");
      }
    }
  }, [stations]);

  // ---- live activity-spots layer: opt-in overlay, distinct marker class ----
  useEffect(() => {
    if (spotsOn) {
      void refresh();
    } else {
      setSpots([]);
      setPickedSpot(null);
    }
  }, [spotsOn, refresh]);

  // re-query spots when the band/mode/source filters change (while the layer is on)
  useEffect(() => {
    if (spotsOn) void refresh();
  }, [spotFilters]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- load detail when a cache is selected ----
  useEffect(() => {
    if (selectedId == null) {
      setDetail(null);
      return;
    }
    let live = true;
    getCache(selectedId, callsignRef.current)
      .then((r) => {
        if (!live) return;
        setDetail(r.cache);
        setDetailFrom(r.offlineFrom ?? null);
      })
      .catch(() => {
        // the core cacher action must never fail silently: say so and close the empty selection
        if (!live) return;
        toast("Couldn't load that cache — check your connection and tap it again.");
        setSelectedId(null);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toast identity is stable (context push)
  }, [selectedId]);

  const reloadDetail = useCallback(async () => {
    if (selectedId == null) return;
    try {
      const r = await getCache(selectedId, callsignRef.current);
      setDetail(r.cache);
      setDetailFrom(r.offlineFrom ?? null);
    } catch {
      toast("Couldn't refresh the cache — check your connection.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- toast identity is stable (context push)
  }, [selectedId]);

  // home QTH (from your profile locator) — feeds the MapTools bearing arc to the selected cache
  const [home, setHome] = useState<[number, number] | null>(null);
  useEffect(() => {
    if (!callsign) {
      setHome(null);
      return;
    }
    let live = true;
    getProfile(callsign)
      .then((p) => {
        if (live) setHome(p.profile?.homeGrid ? gridCenter(p.profile.homeGrid) : null);
      })
      .catch(() => {
        if (live) setHome(null);
      });
    return () => {
      live = false;
    };
  }, [callsign]);
  const target: [number, number] | null =
    detail && detail.lat != null && detail.lon != null ? [detail.lat, detail.lon] : null;

  // global search: a Maidenhead locator or "lat, lon" flies the map there; otherwise filter by text
  function runSearch(raw: string) {
    const q = raw.trim();
    const g = gridCenter(q);
    if (g) {
      flyTo(g[0], g[1], 10);
      return;
    }
    const ll = parseCoordinates(q);
    if (ll) flyTo(ll.lat, ll.lon, 12);
  }

  // enriched-search picks: a cache opens its detail + flies there; a station just flies to it
  function pickCacheHit(hit: SearchHitCache) {
    setFilters((f) => ({ ...f, q: "" }));
    closeAll();
    setSelectedId(hit.id);
    if (hit.lat != null && hit.lon != null) flyTo(hit.lat, hit.lon, 14);
  }
  function pickStationHit(hit: SearchHitStation) {
    setFilters((f) => ({ ...f, q: "" }));
    if (hit.lat != null && hit.lon != null) flyTo(hit.lat, hit.lon, 12);
  }

  async function onCreated(c: CacheSummary) {
    closeView();
    await refresh();
    setSelectedId(c.id);
    if (c.lat != null && c.lon != null) mapRef.current?.flyTo({ center: [c.lon, c.lat], zoom: 14 });
  }

  const onNav = (key: (typeof NAV_ITEMS)[number]["key"]) => openView(viewOf(key));
  const pinnedApps = pins.map(appById).filter((a): a is ShackApp => !!a && (sysop || !a.sysop));
  const railKeys = new Set([...NAV_ITEMS.map((i) => i.key), ...pinnedApps.map((a) => a.id)]);
  const tabKeys = new Set(TAB_ITEMS.map((i) => i.key));
  const ctx = useMemo(() => ({ session, map }), [session, map]);

  return (
    <PlatformContext.Provider value={ctx}>
      <FormatContext.Provider value={fmt}>
        <div className="app">
          <TopBar
            callsign={callsign}
            verified={verified}
            onAccount={() => openView(panel(session.signedIn ? "settings" : "signin"))}
            onHide={() => openView(panel("hide"))}
            count={shown.length}
            syncLine={sync.line}
            attention={sync.status.attention}
            onQueue={() => openView(panel("outbox"))}
            onFilters={() => openView(panel("filter"))}
            filtered={filters.types.length > 0 || filters.q.length > 0}
            q={filters.q}
            onSearch={(v) => setFilters({ ...filters, q: v })}
            onSearchSubmit={runSearch}
            onPickCache={pickCacheHit}
            onPickStation={pickStationHit}
            onNearby={() => openView(panel("nearby"))}
            onActivity={() => openView(panel("activity"))}
            onProfile={() => openView(panel("profile"))}
            onDocs={() => openView(panel("docs"))}
            sysop={sysop}
            onAdmin={() => openView(panel("admin"))}
          />
          <div className="shell">
            <NavRail
              active={activeKey(view, railKeys)}
              onNav={onNav}
              pinnedApps={pinnedApps}
              onLaunchApp={launchApp}
              sysop={sysop}
            />

            {/* the left dock: exactly one surface (the open View) — docked left at ≥1024px */}
            {hiding && (
              <HidePanel
                draft={draft}
                onPlace={(lat, lon) => {
                  const m = mapRef.current;
                  if (!m) return;
                  placeDraftPin(m, draftMarker, setDraft, lat, lon);
                  m.flyTo({ center: [lon, lat], zoom: Math.max(m.getZoom(), 16) });
                }}
                onCancel={closeView}
                onCreated={onCreated}
              />
            )}
            {isPanel("nearby") && (
              <NearbyPanel
                caches={shown}
                stations={stations}
                selectedId={selectedId}
                onPick={(id) => {
                  // docked (≥1024px) the detail opens beside the list; as a sheet it replaces it
                  if (!op) closeAll();
                  openCache(id);
                }}
                onOffline={() => openView(panel("offline"))}
                onClose={closeView}
              />
            )}
            {isPanel("activity") && <ActivityPanel onBoard={() => openView(panel("ranks"))} onClose={closeView} />}
            {isPanel("outbox") && <OutboxPanel onClose={closeView} />}
            {isPanel("offline") && <OfflinePanel onClose={closeView} />}
            {isPanel("messages") && <MessagesPanel onClose={closeView} />}
            {isPanel("filter") && (
              <FilterPanel
                filters={filters}
                setFilters={setFilters}
                count={shown.length}
                includeUnvetted={includeUnvetted}
                setIncludeUnvetted={setIncludeUnvetted}
                spotsOn={spotsOn}
                setSpotsOn={setSpotsOn}
                stationsOn={stationsOn}
                setStationsOn={setStationsOn}
                meshcomOn={meshcomOn}
                setMeshcomOn={setMeshcomOn}
                meshcomLinksOn={meshcomLinksOn}
                setMeshcomLinksOn={setMeshcomLinksOn}
                spotFilters={spotFilters}
                setSpotFilters={setSpotFilters}
                getViewState={getViewState}
                onClose={closeView}
              />
            )}
            {isPanel("profile") && (
              <ProfilePanel
                onShack={() => openView(panel("shack"))}
                onMail={() => launchApp("bbs")}
                onSettings={() => openView(panel("settings"))}
                onSignIn={() => openView(panel("signin"))}
                onClose={closeView}
              />
            )}
            {isPanel("ranks") && <CommunityPanel onClose={closeView} />}
            {isPanel("shack") && (
              <ShackPanel
                onClose={closeView}
                apps={visibleApps}
                pinned={pins}
                onLaunchApp={launchApp}
                onTogglePin={togglePin}
              />
            )}
            {view.kind === "app" && <ShackAppSurface app={view.id} onClose={closeView} />}
            {view.kind === "station" && (
              <StationPanel picked={view.call} onFly={(lat, lon) => flyTo(lat, lon, 12)} onClose={closeView} />
            )}
            {isPanel("signin") && (
              <SignIn
                onDone={() => {
                  session.refresh();
                  closeView();
                }}
                onClose={closeView}
              />
            )}
            {isPanel("settings") && (
              <SettingsPanel
                settings={locSettings}
                onApply={applySettings}
                onFly={(lat, lon) => flyTo(lat, lon, 12)}
                operatorPending={operatorPending}
                onSignIn={() => openView(panel("signin"))}
                onDocs={() => openView(panel("docs"))}
                onClose={closeView}
              />
            )}
            {isPanel("admin") && sysop && (
              <AdminPanel
                onDocs={(slug) => {
                  setDocSlug(slug);
                  openView(panel("docs"));
                }}
                onClose={closeView}
              />
            )}
            {isPanel("docs") && (
              <Suspense fallback={null}>
                <DocsPanel initialSlug={docSlug} onClose={closeView} />
              </Suspense>
            )}

            <div className="mapwrap">
              <div ref={setMapNode} className="map" data-tour="map" />
              <ToolMapLayers map={map} />
              {/* §6 — `map`-capability tools render markers here */}
              {ready && center && (
                <div className="coordreadout">
                  <div>
                    <div className="crl">Lat / Lon</div>
                    <div className="crv">
                      {center[0].toFixed(4)}° {center[1].toFixed(4)}°
                    </div>
                  </div>
                  <div>
                    <div className="crl">Grid</div>
                    <div className="crv">{maidenhead(center[0], center[1], 10)}</div>
                  </div>
                  <div>
                    <div className="crl">MGRS</div>
                    <div className="crv">{toMgrs(center[0], center[1], 4) || "—"}</div>
                  </div>
                </div>
              )}
              {offlineMap && (
                <div className="offline-banner" role="status">
                  <span>
                    Offline —{" "}
                    {offlineMap.source
                      ? `caches from ${offlineMap.source.auto ? "" : "pack "}“${offlineMap.source.name}”, ${ageText(offlineMap.source.refreshedAt)}${offlineMap.source.packs > 1 ? ` (+${offlineMap.source.packs - 1} more)` : ""}`
                      : "no offline pack covers this area"}
                  </span>
                  <Button variant="quiet" onClick={() => openView(panel("offline"))}>
                    Packs
                  </Button>
                </div>
              )}
              {/* the viewer's own fix: the cache sheet shows the distance to it */}
              <LocateControl map={map} onFix={(lat, lon) => setHere({ lat, lon })} />
              {ready && <BasemapSwitcher map={map} styleEpoch={styleEpoch} />}
              {ready && meshcomOn && meshcomLinksOn && (
                <MeshcomLinks map={map} links={meshcomLinks} styleEpoch={styleEpoch} />
              )}
              {ready && <MapTools map={map} home={home} target={target} styleEpoch={styleEpoch} />}
              {mapFailed && (
                <div className="map-unavailable" role="status">
                  <p className="inline-note bad">{NO_WEBGL_TEXT}</p>
                  <Button variant="primary" onClick={() => openView(panel("nearby"))}>
                    Open the Nearby list
                  </Button>
                </div>
              )}
              {!ready && !mapFailed && (
                <div className="splash">
                  <img src={ASSET.wordmark} alt="APRScaching" />
                </div>
              )}
              {nearPrompt && !hiding && (
                <div className="geo-banner">
                  <span>
                    <Icon name="place" cp437="" className="lead-ic" />
                    You're near <strong>{nearPrompt.code}</strong> — {nearPrompt.title}
                    <span className="muted"> · {fmt.distance(nearPrompt.distanceM)}</span>
                  </span>
                  <span className="spacer" />
                  <Button
                    variant="primary"
                    onClick={() => {
                      openCache(nearPrompt.cacheId);
                      setNearPrompt(null);
                      const m = mapRef.current;
                      m?.flyTo({ center: m.getCenter(), zoom: Math.max(m.getZoom(), 14) });
                    }}
                  >
                    Log it
                  </Button>
                  <Button variant="icon" aria-label="Dismiss" onClick={() => setNearPrompt(null)}>
                    ✕
                  </Button>
                </div>
              )}
              {pickedSpot && !hiding && (
                <SpotCard
                  spot={pickedSpot}
                  onClose={() => setPickedSpot(null)}
                  onViewCache={(() => {
                    const c = caches.find(
                      (c) =>
                        c.id != null &&
                        c.lat != null &&
                        c.lon != null &&
                        haversine(pickedSpot.lat, pickedSpot.lon, c.lat, c.lon) <= 300,
                    );
                    return c
                      ? () => {
                          openCache(c.id!);
                          setPickedSpot(null);
                        }
                      : undefined;
                  })()}
                />
              )}
            </div>

            {/* right dock: cache detail / mirrored cache — docked right at ≥1024px (coexists with a left panel) */}
            {detail && !hiding && !remote && !isPanel("ranks") && (
              <DetailPanel
                detail={detail}
                here={here}
                activating={
                  detail.lat != null && detail.lon != null
                    ? (spots.find((s) => haversine(s.lat, s.lon, detail.lat!, detail.lon!) <= 300) ?? null)
                    : null
                }
                offlineFrom={detailFrom}
                onClose={() => setSelectedId(null)}
                onLogged={reloadDetail}
                onSignIn={() => openView(panel("signin"))}
              />
            )}
            {remote && !hiding && !isPanel("ranks") && (
              <RemoteCachePanel cache={remote} onClose={() => setRemote(null)} />
            )}
          </div>

          {!hiding && (
            <TabBar
              active={activeKey(view, tabKeys)}
              onNav={onNav}
              fabLabel={selectedId != null || nearPrompt ? "Log" : "Hide"}
              onFab={() => {
                if (nearPrompt) {
                  closeAll();
                  setSelectedId(nearPrompt.cacheId);
                } else if (selectedId == null) openView(panel("hide"));
              }}
            />
          )}
          {tourOpen && <Tour steps={TOUR_STEPS} signedIn={!!callsign} onDone={() => setTourOpen(false)} />}
        </div>
      </FormatContext.Provider>
    </PlatformContext.Provider>
  );
}

/** "2 days old", "3 h old", "just refreshed": the age of an offline pack. */
function ageText(refreshedAtMs: number): string {
  const h = (Date.now() - refreshedAtMs) / 3_600_000;
  if (h < 1) return "just refreshed";
  if (h < 48) return `${Math.round(h)} h old`;
  return `${Math.round(h / 24)} days old`;
}
