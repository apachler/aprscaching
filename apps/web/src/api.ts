// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type AttentionLog,
  type FlushResult,
  type QueuedLog,
  type QueueStore,
  type SendFailure,
  discardAttention,
  enqueue,
  flush,
  loadAttention,
  loadQueue,
  retryAttention,
} from "./log/logQueue.js";
import type {
  CacheSummary,
  CacheDetail,
  CacheLogEntry,
  CreateCacheRequest,
  MapCache,
  LogType,
  AppGeo,
  TrustTier,
  LeaderboardEntry,
  Profile,
  StationSummary,
  StationDetail,
  DecodedPacket,
  PortStat,
  MessageItem,
  Spot,
} from "@aprscaching/shared";

export type {
  CacheSummary,
  CacheDetail,
  CacheLogEntry,
  CreateCacheRequest,
  MapCache,
  LogType,
  AppGeo,
  TrustTier,
  LeaderboardEntry,
  Profile,
  StationSummary,
  StationDetail,
  DecodedPacket,
  PortStat,
  MessageItem,
  Spot,
};
import { offlineStore, type OfflineStore } from "./offline/store.js";
import { migrateLegacy, packCache, packCachesInBox, saveAutoArea, type OfflineSource } from "./offline/packs.js";
import { imageKey } from "./offline/download.js";
import { fromB64u, toB64u } from "./base64url.js";

/**
 * Gateway base URL. A dev server talks to the local gateway on :8787. A production build without
 * `VITE_API_BASE` talks to its own origin (`""`), which is right wherever one host serves both the SPA and
 * the API (the desktop binary, a Pi, an all-in-one VM) and fails visibly anywhere else — never a silent
 * localhost that only answers on the builder's machine. A split deployment (Pages + a Worker on
 * `api.aprscaching.net`) sets `VITE_API_BASE` at build time.
 */
/** Drop trailing `/` from a URL without a regex (the URL can be typed by the user). */
export function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end--;
  return url.slice(0, end);
}

export const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? (import.meta.env.PROD ? "" : "http://127.0.0.1:8787");

/**
 * The browser could not reach the gateway at all (offline, DNS, CORS, the server down). It stays a
 * `TypeError`, as `fetch` throws, so offline handling that tests for one still recognises it, but carries
 * a message a person can act on instead of the browser's "Failed to fetch".
 */
export class NetworkError extends TypeError {
  constructor() {
    super("Can't reach the server — check your connection and try again");
  }
}

/** Human text for any error shown to a user: the server's reason, or the network failure in words. */
export function errorText(e: unknown): string {
  if (e instanceof NetworkError) return e.message;
  const m = e instanceof Error ? e.message : String(e);
  // the browsers' own words for an unreachable host: Chromium, Firefox, Safari
  if (e instanceof TypeError && /failed to fetch|networkerror|load failed/i.test(m)) return new NetworkError().message;
  return m.replace(/^\d{3} /, "");
}

/** `fetch` that throws a {@link NetworkError} when the host cannot be reached; an abort stays an abort. */
async function reach(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw new NetworkError();
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  // A JSON content-type makes a cross-origin request non-simple, so it is sent only with a JSON body: a GET
  // without it needs no CORS preflight.
  const json = typeof init?.body === "string" ? { "content-type": "application/json" } : undefined;
  const res = await reach(API_BASE + path, {
    ...init,
    credentials: "include",
    headers: { ...json, ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(body.error ?? `${res.status} ${res.statusText}`, res.status, body);
  return body;
}

/** A refused API call: the server's message, its HTTP status and the JSON body it sent. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data: unknown,
  ) {
    super(message);
  }
}

export type BBox = [minLon: number, minLat: number, maxLon: number, maxLat: number];

let offlineReadyP: Promise<OfflineStore> | null = null;
/** The offline store (offline/store.ts), once what earlier versions kept in localStorage has moved into it. */
export function offlineReady(): Promise<OfflineStore> {
  offlineReadyP ??= (async () => {
    const st = offlineStore();
    try {
      await migrateLegacy(st, localStorage, localStorage.getItem("acs.instance") ?? "", Date.now());
    } catch {
      /* nothing to move, or no storage: the store starts empty */
    }
    return st;
  })();
  return offlineReadyP;
}
const knownInstance = () => {
  try {
    return localStorage.getItem("acs.instance") ?? "";
  } catch {
    return "";
  }
};

/**
 * The caches in view. Each answer is kept as the automatic offline pack (the area last browsed); without
 * a connection the caches of every offline pack in view are shown instead, with where they came from.
 */
export async function listCaches(
  bbox: BBox,
  includeUnvetted = false,
): Promise<{ caches: MapCache[]; offline?: boolean; source?: OfflineSource | null }> {
  try {
    const r = await call<{ caches: MapCache[] }>(
      `/api/caches?bbox=${bbox.join(",")}${includeUnvetted ? "&includeUnvetted=1" : ""}`,
    );
    void offlineReady()
      .then((st) => saveAutoArea(st, r.caches, bbox, knownInstance(), Date.now()))
      .catch(() => {});
    return r;
  } catch (e) {
    if (!isOffline(e)) throw e;
    const off = await packCachesInBox(await offlineReady(), bbox);
    return { caches: off.caches, offline: true, source: off.source };
  }
}

/** The pack a cache page was read from while offline. */
export interface OfflineFrom {
  name: string;
  refreshedAt: number;
  auto: boolean;
}

/** A cache's page; without a connection, its copy in an offline pack (`offlineFrom` says which). */
export async function getCache(
  id: number,
  callsign?: string,
): Promise<{ cache: CacheDetail; offlineFrom?: OfflineFrom }> {
  try {
    return await call(`/api/caches/${id}${callsign ? `?callsign=${encodeURIComponent(callsign)}` : ""}`);
  } catch (e) {
    if (!isOffline(e)) throw e;
    const hit = await packCache(await offlineReady(), id);
    if (!hit || hit.cache.id == null) throw e;
    const c = hit.cache;
    const cache: CacheDetail = {
      id: hit.cache.id,
      code: c.code,
      ownerCall: c.ownerCall,
      title: c.title,
      type: c.type,
      status: c.status,
      difficulty: c.difficulty,
      terrain: c.terrain,
      lat: c.lat,
      lon: c.lon,
      stationCall: c.stationCall,
      source: c.source,
      sourceName: c.sourceName,
      sourceUrl: c.sourceUrl,
      minTrust: c.minTrust,
      fedScope: c.fedScope,
      driveIn: c.driveIn,
      country: c.country,
      tags: c.tags,
      hint: c.hint,
      description: c.description,
      externalId: c.externalId,
      createdAt: c.createdAt ?? 0,
      updatedAt: c.updatedAt ?? 0,
      // counts and ratings are the instance's live figures; a pack does not hold them
      finds: 0,
      logs: c.logs,
      logsHasMore: false,
      favorites: 0,
      favorited: false,
      needsMaintenance: false,
      dnfStreak: 0,
      lastFound: null,
      rating: { avg: null, count: 0, mine: null, policy: "off", canRate: false },
      rendezvous: [],
      stageCount: c.stages.length,
    };
    return {
      cache,
      offlineFrom: { name: hit.pack.name, refreshedAt: hit.pack.refreshedAt, auto: !!hit.pack.auto },
    };
  }
}

export function getLeaderboard(bbox: BBox, metric: "finds" | "points"): Promise<{ leaderboard: LeaderboardEntry[] }> {
  return call(`/api/leaderboard?metric=${metric}&bbox=${bbox.join(",")}`);
}
import type { Corroborator } from "@aprscaching/shared";
export type { Corroborator };
/** Top receiving stations by the finds they made Radio-verified — running infrastructure as a visible contribution. */
export function getCorroborators(
  bbox?: BBox,
  period = "all",
): Promise<{ period: string; corroborators: Corroborator[] }> {
  const q = new URLSearchParams({ period });
  if (bbox) q.set("bbox", bbox.join(","));
  return call(`/api/corroborators?${q.toString()}`);
}
export interface ProfileEdit {
  displayName?: string;
  homeGrid?: string;
  avatarUrl?: string;
  bio?: string;
  links?: { label: string; url: string }[];
  publicContact?: string;
  profilePublic?: boolean;
}
export function updateProfile(p: ProfileEdit): Promise<{ ok: boolean }> {
  return call(`/auth/profile`, { method: "POST", body: JSON.stringify(p) });
}
export function getProfile(callsign: string): Promise<Profile> {
  return call(`/api/profile/${encodeURIComponent(callsign)}`);
}
import type { SearchResults } from "@aprscaching/shared";
export type { SearchResults, SearchHitCache, SearchHitStation } from "@aprscaching/shared";
/** Enriched as-you-type suggestions across caches + stations. */
export function searchSuggest(q: string, signal?: AbortSignal, limit = 8): Promise<SearchResults> {
  return call(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`, { signal });
}
import type { ActivityItem, PageInfo } from "@aprscaching/shared";
export type { ActivityItem };
/** Keyset-paginated recent finds. Pass nextCursor back as `cursor` for older pages. */
export function getActivity(
  bbox?: BBox,
  cursor?: string | null,
  limit = 30,
): Promise<{ activity: ActivityItem[] } & PageInfo> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (bbox) q.set("bbox", bbox.join(","));
  if (cursor) q.set("cursor", cursor);
  return call(`/api/activity?${q.toString()}`);
}
/** Paginated logbook for a cache (older entries past the embedded first page). */
export function getCacheLogs(
  id: number,
  cursor?: string | null,
  limit = 50,
): Promise<{ logs: CacheLogEntry[] } & PageInfo> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (cursor) q.set("cursor", cursor);
  return call(`/api/caches/${id}/logs?${q.toString()}`);
}
export function toggleFavorite(
  cacheId: number,
  callsign: string,
  on: boolean,
): Promise<{ on: boolean; count: number }> {
  return call(`/api/caches/${cacheId}/favorite`, { method: "POST", body: JSON.stringify({ callsign, on }) });
}
export type CacheRating = CacheDetail["rating"];
/** Submit a 1–5 star rating (owner-gated) — returns the updated aggregate. */
export function rateCache(cacheId: number, stars: number, callsign?: string): Promise<{ rating: CacheRating }> {
  return call(`/api/caches/${cacheId}/rate`, { method: "POST", body: JSON.stringify({ stars, callsign }) });
}

// ---- live activity spots — read-only overlay, opt-in ----
export function getSpots(
  bbox: BBox,
  opts: { bands?: string[]; modes?: string[]; sources?: string[] } = {},
): Promise<{ enabled: boolean; count: number; fetchedAt: number | null; spots: Spot[] }> {
  const q = new URLSearchParams({ bbox: bbox.join(",") });
  if (opts.bands?.length) q.set("bands", opts.bands.join(","));
  if (opts.modes?.length) q.set("modes", opts.modes.join(","));
  if (opts.sources?.length) q.set("sources", opts.sources.join(","));
  return call(`/api/spots?${q.toString()}`);
}

// ---- MeshCom layer: nodes and links as this instance's MeshCom node(s) heard them ----
export type MeshcomVia = "direct" | "relayed" | "server" | "node";
export interface MeshcomNode {
  callsign: string;
  lat: number;
  lon: number;
  symbol: string | null;
  lastHeard: number;
  via: MeshcomVia;
  receiver: string | null;
  hwId: number | null;
  firmware: string | null;
  quality: "strong" | "usable" | "weak" | null;
  battLevel: "high" | "medium" | "low" | null;
  /** The relays the node's latest message allowed to forward it (its `--via` list); absent when it named none. */
  sentVia?: string[];
  /** Exact figures, for signed-in members only. */
  batt?: number | null;
  rssi?: number | null;
  snr?: number | null;
}
export interface MeshcomLink {
  from: string;
  to: string;
  kind: "direct" | "relay";
  lastSeen: number;
  samples: number;
  receiver: string | null;
  fromLat: number;
  fromLon: number;
  toLat: number;
  toLon: number;
  quality: "strong" | "usable" | "weak" | null;
  rssi?: number | null;
  snr?: number | null;
}
export function getMeshcomNodes(
  bbox: BBox | null,
  opts: { call?: string } = {},
): Promise<{ exact: boolean; nodes: MeshcomNode[] }> {
  const q = new URLSearchParams();
  if (bbox) q.set("bbox", bbox.join(","));
  if (opts.call) q.set("call", opts.call);
  return call(`/api/meshcom/nodes?${q.toString()}`);
}
export function getMeshcomLinks(bbox: BBox): Promise<{ exact: boolean; links: MeshcomLink[] }> {
  return call(`/api/meshcom/links?bbox=${bbox.join(",")}`);
}

// ---- shack: live stations + packet inspector ----
export function getStations(bbox: BBox): Promise<{ stations: StationSummary[] }> {
  return call(`/api/stations?bbox=${bbox.join(",")}`);
}
export function getStation(callsign: string): Promise<{ station: StationDetail }> {
  return call(`/api/stations/${encodeURIComponent(callsign)}`);
}
export interface WxPoint {
  ts: number;
  tempC: number | null;
  humidity: number | null;
  pressureHpa: number | null;
  windKn: number | null;
  gustKn: number | null;
  rainMm: number | null;
  rain24hMm: number | null;
}
export interface MotionPoint {
  ts: number;
  speedKn: number | null;
  altitudeM: number | null;
  course: number | null;
}
export interface StationSeries {
  callsign: string;
  windowSec: number;
  wx: WxPoint[];
  motion: MotionPoint[];
}
/** Windowed telemetry + weather series for the shack graphs. */
export function getStationSeries(callsign: string, windowSec = 86400, signal?: AbortSignal): Promise<StationSeries> {
  return call(`/api/stations/${encodeURIComponent(callsign)}/series?window=${Math.floor(windowSec)}`, { signal });
}
export interface RawPacket {
  ts: number;
  dst: string | null;
  path: string | null;
  payload: string | null;
  heardVia: string | null;
  port: string | null;
  tnc2: string;
}
/** Recent raw TNC2 frames heard from a station — shack diagnostic. */
export function getStationPackets(
  callsign: string,
  limit = 50,
  signal?: AbortSignal,
): Promise<{ callsign: string; count: number; packets: RawPacket[] }> {
  return call(`/api/stations/${encodeURIComponent(callsign)}/packets?limit=${Math.floor(limit)}`, { signal });
}
import type { StationTrackPoint } from "@aprscaching/shared";
export type { StationTrackPoint };
export interface StationTrack {
  callsign: string;
  from: number;
  until: number;
  count: number;
  positions: StationTrackPoint[];
}
/** Date-windowed position history via the public read API — free, rate-limited. */
export function getStationTrack(
  callsign: string,
  fromSec: number,
  toSec: number,
  signal?: AbortSignal,
): Promise<StationTrack> {
  return call(
    `/api/v1/station/${encodeURIComponent(callsign)}/track?from=${Math.floor(fromSec)}&to=${Math.floor(toSec)}`,
    { signal },
  );
}
export function decodePacket(raw: string): Promise<DecodedPacket> {
  return call(`/api/decode`, { method: "POST", body: JSON.stringify({ raw }) });
}
export function getPorts(): Promise<{ window: string; ports: PortStat[] }> {
  return call(`/api/ports`);
}
export function getMessages(
  bulletins = false,
  cursor?: string | null,
  limit = 30,
): Promise<{ messages: MessageItem[] } & PageInfo> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (bulletins) q.set("bulletins", "1");
  if (cursor) q.set("cursor", cursor);
  return call(`/api/messages?${q.toString()}`);
}

// ---- logs sent over the air (FOUND / DNF / NOTE radio messages) ----
export interface RadioCommandRow {
  id: number;
  fromCall: string;
  command: "found" | "dnf" | "note" | "help" | "invalid";
  cacheCode?: string | null;
  body?: string | null;
  trusted: boolean;
  status: "logged" | "pending" | "confirming" | "rejected" | "help" | "discarded" | "expired";
  reason?: string | null;
  sentAt: number;
  decidedAt?: number | null;
  tier?: "A" | "B" | "C";
  verified?: boolean;
}
export function getRadioCommands(): Promise<{ serviceCall: string; commands: RadioCommandRow[] }> {
  return call("/api/radio/commands");
}
export function decideRadioCommand(
  id: number,
  decision: "confirm" | "discard",
): Promise<{ ok: boolean; status: string; error?: string }> {
  return call(`/api/radio/commands/${id}/${decision}`, { method: "POST", body: "{}" });
}

// ---- remote control of your own ingest box ----
export interface BoxCommand {
  id: number;
  callsign?: string;
  kind: string;
  payload?: unknown;
  status: "queued" | "sent" | "done" | "failed";
  result?: string;
  createdAt: number;
  sentAt?: number | null;
  ackedAt?: number | null;
}
export function enqueueBoxCommand(
  boxId: string,
  cmd: { kind: string; payload?: unknown; callsign?: string },
): Promise<{ id: number; boxId: string; kind: string; callsign: string; status: string; tx: boolean }> {
  return call(`/api/box/${encodeURIComponent(boxId)}/command`, { method: "POST", body: JSON.stringify(cmd) });
}
export function getBoxLog(boxId: string): Promise<{ boxId: string; commands: BoxCommand[] }> {
  return call(`/api/box/${encodeURIComponent(boxId)}/log`);
}
/** Link a box to the signed-in account with the pairing code the box printed at start. */
export function pairBox(boxId: string, code: string): Promise<{ ok: boolean; boxId: string }> {
  return call(`/api/box/${encodeURIComponent(boxId)}/claim`, { method: "POST", body: JSON.stringify({ code }) });
}
/** Did the gateway refuse because this box is not paired to the signed-in account yet? */
export const needsPairing = (e: unknown): boolean =>
  e instanceof ApiError && (e.data as { pair?: boolean } | null)?.pair === true;

// ---- watchlist + alerts ----
export interface WatchEntry {
  callsign: string;
  addedAt: number;
}
export interface WatchAlert {
  id: number;
  callsign: string;
  kind: "heard" | "near_cache" | "cache_found" | "corroborated";
  detail?: string;
  cacheId?: number | null;
  lat?: number | null;
  lon?: number | null;
  ts: number;
  seen: boolean;
}
export function listWatch(): Promise<{ watching: WatchEntry[]; unseen: number }> {
  return call(`/api/watch`);
}
export function addWatch(callsign: string): Promise<{ ok: boolean; callsign: string }> {
  return call(`/api/watch`, { method: "POST", body: JSON.stringify({ callsign }) });
}
export function removeWatch(callsign: string): Promise<{ ok: boolean }> {
  return call(`/api/watch/${encodeURIComponent(callsign)}`, { method: "DELETE" });
}
export function getWatchAlerts(cursor?: string | null, limit = 50): Promise<{ alerts: WatchAlert[] } & PageInfo> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (cursor) q.set("cursor", cursor);
  return call(`/api/watch/alerts?${q.toString()}`);
}
export function markWatchSeen(): Promise<{ ok: boolean }> {
  return call(`/api/watch/seen`, { method: "POST" });
}

// ---- save / share map views ----
export interface MapViewState {
  center?: [number, number];
  zoom?: number;
  layers?: { spots?: boolean; stations?: boolean; meshcom?: boolean; meshcomLinks?: boolean };
  filters?: { types: string[]; q: string };
  spotFilters?: { bands: string[]; modes: string[]; sources: string[] };
  selected?: number | null;
}
export function saveView(state: MapViewState, name?: string): Promise<{ slug: string; public: boolean }> {
  return call(`/api/views`, { method: "POST", body: JSON.stringify({ state, name }) });
}
export function resolveView(
  slug: string,
): Promise<{ slug: string; name: string | null; ownerCall: string; createdAt: number; state: MapViewState }> {
  return call(`/v/${encodeURIComponent(slug)}`);
}

// ---- account-level UI preferences sync: theme, units/locale, pinned apps, basemap ----
export type AccountPrefs = Record<string, unknown>;
export function getPrefs(): Promise<{ prefs: AccountPrefs }> {
  return call(`/api/prefs`);
}
export function putPrefs(prefs: AccountPrefs): Promise<{ ok: boolean; prefs: AccountPrefs }> {
  return call(`/api/prefs`, { method: "PUT", body: JSON.stringify({ prefs }) });
}

// ---- notification prefs + push subscription ----
export function getNotifyPrefs(): Promise<{ digest: boolean; hasEmail: boolean; pushConfigured: boolean }> {
  return call(`/api/notify/prefs`);
}
export function setNotifyPrefs(digest: boolean): Promise<{ digest: boolean }> {
  return call(`/api/notify/prefs`, { method: "POST", body: JSON.stringify({ digest }) });
}
export function getPushKey(): Promise<{ key: string | null }> {
  return call(`/api/push/key`);
}
export function subscribePush(sub: {
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
}): Promise<{ ok: boolean }> {
  return call(`/api/push/subscribe`, {
    method: "POST",
    body: JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys, topics: ["watch"] }),
  });
}
export function unsubscribePush(endpoint: string): Promise<{ ok: boolean }> {
  return call(`/api/push/unsubscribe`, { method: "POST", body: JSON.stringify({ endpoint }) });
}
// ---- weather user-origination: a personal weather station ----
export interface WxKeyInfo {
  callsign: string;
  station: string;
  key: string | null;
  lastSeen: number | null;
  ecowittPath: string | null;
  wuUrl: string | null;
  txIs?: boolean;
  txCwop?: boolean;
  verified?: boolean; // APRS-IS weather beacon / CWOP relay TX opt-in + control-verified gate
}
/** Read the caller's PWS push key + ready-to-paste station URLs (null key until issued). */
export function getWxKey(): Promise<WxKeyInfo> {
  return call(`/api/wx/key`);
}
/** (Re)issue the PWS push key — invalidates any previous one. */
export function issueWxKey(): Promise<WxKeyInfo> {
  return call(`/api/wx/key`, { method: "POST" });
}
/** Submit one in-browser-decoded PWS reading to the direct PWS ingest, using the caller's key.
 *  Metric → the imperial query params parseWx already understands, so it reuses the whole ingest path. */
export function submitWxReading(
  key: string,
  r: {
    tempC?: number;
    humidity?: number;
    pressureHpa?: number;
    windDirDeg?: number;
    windKn?: number;
    rainTodayMm?: number;
  },
): Promise<void> {
  const q = new URLSearchParams({ key });
  const set = (k: string, v: number, dp: number) => q.set(k, v.toFixed(dp));
  if (r.tempC != null) set("tempf", (r.tempC * 9) / 5 + 32, 1);
  if (r.humidity != null) set("humidity", r.humidity, 0);
  if (r.pressureHpa != null) set("baromin", r.pressureHpa / 33.8638867, 2);
  if (r.windDirDeg != null) set("winddir", r.windDirDeg, 0);
  if (r.windKn != null) set("windspeedmph", r.windKn * 1.15078, 1);
  if (r.rainTodayMm != null) set("dailyrainin", r.rainTodayMm / 25.4, 2);
  return reach(`${API_BASE}/api/wx/submit?${q.toString()}`, { credentials: "include" }).then((res) => {
    if (!res.ok) throw new Error(`submit failed (${res.status})`);
  });
}

export interface WxTxState {
  txIs: boolean;
  txCwop: boolean;
  verified: boolean;
}
/** Toggle APRS-IS weather beacon / CWOP relay for the home or a registry-station PWS. */
export function setWxTx(body: { stationId?: number; txIs: boolean; txCwop: boolean }): Promise<WxTxState> {
  return call(`/api/wx/tx`, { method: "POST", body: JSON.stringify(body) });
}

// ---- operated-stations registry: manage your own stations ----
import type { OperatedStation, StationRole, StationWxKey } from "@aprscaching/shared";
export type { OperatedStation, StationRole, StationWxKey };
export interface StationInput {
  callsign?: string;
  lat?: number | null;
  lon?: number | null;
  symbol?: string | null;
  description?: string | null;
  roles?: StationRole[];
}
export function listMyStations(
  cursor?: string | null,
  limit = 50,
): Promise<{ stations: OperatedStation[] } & PageInfo> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (cursor) q.set("cursor", cursor);
  return call(`/api/my/stations?${q.toString()}`);
}
export function createStation(s: StationInput): Promise<{ station: OperatedStation }> {
  return call(`/api/my/stations`, { method: "POST", body: JSON.stringify(s) });
}
export function updateStation(id: number, s: StationInput): Promise<{ station: OperatedStation }> {
  return call(`/api/my/stations/${id}`, { method: "PATCH", body: JSON.stringify(s) });
}
export function deleteStation(id: number): Promise<{ ok: boolean }> {
  return call(`/api/my/stations/${id}`, { method: "DELETE" });
}
export function getStationWxKey(id: number): Promise<StationWxKey> {
  return call(`/api/my/stations/${id}/wx-key`);
}
export function issueStationWxKey(id: number): Promise<StationWxKey> {
  return call(`/api/my/stations/${id}/wx-key`, { method: "POST" });
}
/** Turn an operated station into an APRScache at its location (single, or a beacon-following living cache). */
export function stationToCache(
  id: number,
  opts: { living?: boolean; title?: string } = {},
): Promise<{ cache: CacheSummary }> {
  return call(`/api/my/stations/${id}/cache`, { method: "POST", body: JSON.stringify(opts) });
}
/** "Become a cache" — an aprs_living cache that follows your own beacon (placed at your beacon/home). */
export function becomeACache(opts: { title?: string } = {}): Promise<{ cache: CacheSummary }> {
  return call(`/api/me/cache`, { method: "POST", body: JSON.stringify(opts) });
}

// ---- supporter recognition + public ledger — recognition only, gates nothing ----
export interface SupportLedger {
  currency: string;
  totalInCents: number;
  totalOutCents: number;
  balanceCents: number;
  buckets: Record<string, { inCents: number; outCents: number }>;
  months: { month: string; inCents: number; outCents: number }[];
}
export interface SupportInfo {
  model: string;
  donationLinks: { label: string; url: string }[];
  ledger: SupportLedger;
  supporters: string[];
  supporterCount: number;
}
export interface SupportPrefs {
  supporter: boolean;
  hideNag: boolean;
}
export function getSupport(): Promise<SupportInfo> {
  return call(`/api/support`);
}
export function getSupportPrefs(): Promise<SupportPrefs> {
  return call(`/api/support/prefs`);
}
export function setSupportPrefs(hideNag: boolean): Promise<SupportPrefs> {
  return call(`/api/support/prefs`, { method: "POST", body: JSON.stringify({ hideNag }) });
}
/** The public transparency ledger page (server-rendered on the gateway). */
export const supportUrl = `${API_BASE}/support`;

// ---- browser-direct RF ingest — forward Web Serial KISS frames to a gateway ----
import type { Packet } from "@aprscaching/shared";
import { signIngest } from "./crypto.js";
export type { Packet };
/**
 * Forward decoded RF packets to a gateway's /ingest. Authenticated by the ingest secret, so this is
 * the operator-local / self-host path (the rule's blessed single-operator case): the operator points
 * it at their own gateway. `base` defaults to the configured API base.
 */
export async function ingestPackets(
  packets: Packet[],
  secret: string,
  base = API_BASE,
): Promise<{ ok: boolean; stored: number }> {
  const res = await reach(`${trimTrailingSlashes(base)}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ingest-secret": secret },
    body: JSON.stringify({ packets }),
  });
  if (!res.ok) throw new Error(`ingest ${res.status}`);
  return res.json() as Promise<{ ok: boolean; stored: number }>;
}

/**
 * Forward decoded RF to a PUBLIC gateway, authenticated by the operator's device-key signature
 * — no shared secret. The key must be registered to `callsign` (registerKey).
 * Browser-heard frames are never attested and stay Tier C.
 */
export async function ingestSigned(
  packets: Packet[],
  callsign: string,
  base = API_BASE,
): Promise<{ ok: boolean; stored: number }> {
  const headers = await signIngest(callsign, packets);
  if (!headers) throw new Error("this browser can't sign (needs Ed25519)");
  const res = await reach(`${trimTrailingSlashes(base)}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ packets }),
  });
  if (!res.ok) throw new Error(`ingest ${res.status}`);
  return res.json() as Promise<{ ok: boolean; stored: number }>;
}

/** Public CoT/TAK feed URL for the current viewport (paste into ATAK as a data feed). */
export function cotUrl(bbox: BBox): string {
  return `${API_BASE}/api/cot?bbox=${bbox.join(",")}`;
}

/** A federation peer with its health metrics (operator observability). */
export interface FedPeer {
  url: string;
  instance: string | null;
  signed: number;
  trust: "trusted" | "unvetted" | "blocked";
  added_via?: string | null; // manual | registry | discovered | auto-promoted
  health: "ok" | "error" | "new" | "blocked";
  errorRate: number;
  last_sync: number | null;
  last_ok: number | null;
  last_error: string | null;
  sync_ok: number;
  sync_err: number;
  mirrored_total: number;
  rep_confirmed: number;
  rep_failed: number;
  lastCounts: Record<string, number> | null;
}
export function listFederationPeers(): Promise<{ peers: FedPeer[] }> {
  return call(`/federation/peers`);
}

/** How pushing to the hub stands (a spoke) and when each spoke last submitted (a hub). */
export interface FederationSync {
  hub: {
    url: string;
    lastAttemptAt: number | null;
    lastOkAt: number | null;
    lastError: string | null;
    offlineSince: number | null;
    /** Records past the push cursor per feed, counted up to `waitingCap`. */
    waiting: Record<string, number>;
    waitingCap: number;
  } | null;
  spokes: {
    instance: string;
    trust: string | null;
    lastSubmitAt: number;
    newestCacheChange: number | null;
    stale: boolean;
  }[];
  staleHours: number;
}
export function getFederationSync(): Promise<FederationSync> {
  return call(`/api/admin/federation/sync`);
}
/** Operator: pull from the peers and push to the hub now (runs in the background). */
export function syncFederationNow(): Promise<{ ok: boolean; started: boolean }> {
  return call(`/api/admin/federation/sync`, { method: "POST" });
}
/** Operator: promote/demote/quarantine a federation peer (sysop-gated). */
export function setPeerTrust(url: string, trust: "trusted" | "unvetted" | "blocked"): Promise<{ ok: boolean }> {
  return call(`/federation/peers/trust`, { method: "POST", body: JSON.stringify({ url, trust }) });
}

export interface Fed44netResolved {
  callsign: string;
  host: string;
  instance: string;
  publicKey: string;
  dnssec: boolean;
}
export interface Fed44netResult {
  ok?: boolean;
  admitted?: "dnssec" | "operator-confirmed";
  peer?: { url: string; instance: string; callsign: string; trust: string };
  requiresConfirm?: boolean;
  resolved?: Fed44netResolved;
  descriptorChecked?: boolean;
  error?: string;
}
/** Who to add over 44net: a callsign (`_aprscaching.<call>.ampr.org`) or a host in its zone (`_aprscaching.<host>`). */
export type Fed44netTarget = { callsign: string } | { host: string };
/** The bindings an ambiguous 44net lookup found, carried by its 409 refusal; each is added by its host. */
export type Fed44netCandidate = { instance: string; host: string };
/**
 * Operator: add a peer by its ARDC-verified `<call>.ampr.org` binding (sysop-gated). A
 * DNSSEC-validated binding admits directly; otherwise the response carries the resolved binding and
 * a second call with `confirm: true` pins it. A name carrying several bindings is refused with 409 and
 * `candidates`.
 */
export function add44netPeer(target: Fed44netTarget, confirm = false): Promise<Fed44netResult> {
  return call(`/federation/peers/44net`, { method: "POST", body: JSON.stringify({ ...target, confirm }) });
}

/** The instance's federation descriptor — instance id + signing key, used to compose DNS records. */
export function getFedDescriptor(): Promise<{
  instance: string;
  signed: boolean;
  publicKey: string | null;
  aprsCall: string | null;
  operator: string | null;
  /** the typed transport endpoints this instance publishes (FED_ENDPOINTS) */
  addresses?: { transport: string; address: string }[];
}> {
  return call(`/.well-known/aprscaching`);
}

// ---- instance operator (sysop) admin ----
/** Is the signed-in account the instance operator? Drives whether the admin surface is revealed. */
/** `pending: "verify"` — the session holds an ADMIN_CALLSIGNS call that still needs the operator CLI. */
export function adminWhoami(): Promise<{
  sysop: boolean;
  callsign: string | null;
  configured: boolean;
  pending?: "verify";
}> {
  return call(`/api/admin/whoami`);
}
/** A callsign a sysop verified by hand, with the note saying how control was checked. */
export interface ManualVerification {
  callsign: string;
  verifiedBy: string | null;
  note: string | null;
  verifiedAt: number;
  /** An account on this instance holds the call. */
  held: boolean;
}
export function listManualVerifications(): Promise<{ verifications: ManualVerification[] }> {
  return call(`/api/admin/verifications`);
}
export function addManualVerification(
  callsign: string,
  note: string,
): Promise<{ verified: boolean; callsign: string }> {
  return call(`/api/admin/verifications`, { method: "POST", body: JSON.stringify({ callsign, note }) });
}
export function revokeManualVerification(callsign: string): Promise<{ revoked: boolean }> {
  return call(`/api/admin/verifications/${encodeURIComponent(callsign)}`, { method: "DELETE" });
}
// ---- ingest box enrollment ----
/** An enrolled ingest box; enrolledBy / revokedBy are account ids, or "operator" for the operator secret. */
export interface EnrolledBox {
  box: string;
  label: string | null;
  callsign: string | null;
  enrolledBy: string;
  enrolledAt: number;
  revokedBy: string | null;
  revokedAt: number | null;
  lastSeenAt: number | null;
}
export interface OpenBoxCode {
  label: string | null;
  callsign: string | null;
  createdAt: number;
  expiresAt: number;
}
export function listEnrolledBoxes(): Promise<{ boxes: EnrolledBox[]; openCodes: OpenBoxCode[] }> {
  return call(`/api/admin/boxes`);
}
/** A one-time enrollment code, returned once. */
export function createBoxCode(label: string, callsign: string): Promise<{ code: string; expiresAt: number }> {
  return call(`/api/admin/boxes/codes`, {
    method: "POST",
    body: JSON.stringify({ label: label || undefined, callsign: callsign || undefined }),
  });
}
export function revokeBox(box: string): Promise<{ revoked: boolean }> {
  return call(`/api/admin/boxes/${encodeURIComponent(box)}/revoke`, { method: "POST" });
}
// ---- cache adoption ----
/** A cache as the adoption endpoints serve it; `ownerCall` reads `WITHDRAWN` for an erased owner. */
export interface AdoptionCache {
  id: number;
  code: string;
  title: string;
  type: string;
  status: string;
  lat: number | null;
  lon: number | null;
  ownerCall: string;
  ownerWithdrawn: boolean;
}
/** A cache up for adoption, as the public list serves it. */
export interface AdoptionListing extends AdoptionCache {
  cacheId: number;
  note: string;
  offeredAt: number;
  noticeEndsAt: number;
}
export function listAdoptions(): Promise<{ adoptions: AdoptionListing[] }> {
  return call(`/api/adoptions`);
}
/** One cache's offer and the signed-in caller's own request. */
export interface CacheAdoptionState {
  offer: { note: string; offeredAt: number; noticeEndsAt: number } | null;
  isOwner: boolean;
  request: {
    id: number;
    status: "pending" | "approved" | "declined" | "cancelled";
    callsign: string;
    inPlace: boolean;
    requestedAt: number;
    decidedAt: number | null;
  } | null;
  canRequest: boolean;
  reason: string | null;
}
export function getCacheAdoption(id: number): Promise<CacheAdoptionState> {
  return call(`/api/caches/${id}/adoption`);
}
export function requestAdoption(id: number, inPlace: boolean, note?: string): Promise<unknown> {
  return call(`/api/caches/${id}/adoption`, { method: "POST", body: JSON.stringify({ inPlace, note }) });
}
export function cancelAdoptionRequest(id: number): Promise<unknown> {
  return call(`/api/caches/${id}/adoption/request`, { method: "DELETE" });
}
/** The owner keeps their cache: declines the adoption offer on it. */
export function keepCache(id: number): Promise<unknown> {
  return call(`/api/caches/${id}/adoption`, { method: "DELETE" });
}
/** The sysop's adoption overview. */
export interface AdminAdoptions {
  noticeSec: number;
  withdrawn: AdoptionCache[];
  offered: Array<
    AdoptionCache & {
      note: string;
      offeredBy: string;
      offeredAt: number;
      noticeEndsAt: number;
      requests: Array<{ id: number; callsign: string; inPlace: boolean; note: string | null; requestedAt: number }>;
    }
  >;
  log: Array<{
    id: number;
    cacheId: number;
    code: string | null;
    action: string;
    actor: string;
    from: string | null;
    to: string | null;
    note: string | null;
    at: number;
  }>;
}
export function getAdminAdoptions(): Promise<AdminAdoptions> {
  return call(`/api/admin/adoptions`);
}
export function offerForAdoption(target: { cacheId: number } | { code: string }, note: string): Promise<unknown> {
  return call(`/api/admin/adoptions`, { method: "POST", body: JSON.stringify({ ...target, note }) });
}
export function withdrawAdoptionOffer(cacheId: number): Promise<unknown> {
  return call(`/api/admin/adoptions/${cacheId}`, { method: "DELETE" });
}
export function assignCacheOwner(cacheId: number, callsign: string, note: string, activate: boolean): Promise<unknown> {
  return call(`/api/admin/adoptions/${cacheId}/assign`, {
    method: "POST",
    body: JSON.stringify({ callsign, note, activate }),
  });
}
export function decideAdoptionRequest(requestId: number, decision: "approve" | "decline"): Promise<unknown> {
  return call(`/api/admin/adoptions/requests/${requestId}/${decision}`, { method: "POST", body: "{}" });
}
/** The Setup checklist: env-only settings as read-only statuses (never values) + DB-state probes. */
export interface SetupItem {
  key: string;
  label: string;
  group: "security" | "identity" | "trust" | "legal" | "delivery" | "data";
  /** blocking = sign-in or ingest is broken; recommended = expected of a public instance; optional. */
  level: "blocking" | "recommended" | "optional";
  status: "ok" | "warn" | "missing";
  source: "env" | "db";
  detail: string;
}
/** One threshold (80 % or 100 %) of the daily D1 write budget crossed on one UTC day. */
export interface WriteBudgetAlert {
  day: string;
  threshold: 80 | 100;
  /** unix ms */
  at: number;
  used: number;
  mailed: boolean;
}
/** The daily D1 write budget: today's count and level (`off` when the instance sets none). */
export type WriteBudget =
  | { level: "off"; budget: 0; used: null }
  | { level: "ok" | "warn" | "over"; day: string; used: number; budget: number; alerts: WriteBudgetAlert[] };
export function getAdminSetup(): Promise<{ items: SetupItem[]; budget: WriteBudget }> {
  return call(`/api/admin/setup`);
}
/** One line of the 44Net self-check; `fix` is set on every warn and fail. */
export interface Net44CheckLine {
  id: "endpoint" | "a" | "txt" | "descriptor" | "dnssec" | "aaaa";
  status: "pass" | "warn" | "fail" | "info";
  label: string;
  detail: string;
  fix?: string;
}
/** The read-only 44Net self-check: what peers find in DNS when they add this instance by callsign. */
export function run44netCheck(): Promise<
  { applicable: false } | { applicable: true; callsign: string | null; host: string; lines: Net44CheckLine[] }
> {
  return call(`/api/admin/setup/44net`);
}
/** FBB forwarding routing rules (route token → partner). Sysop-gated. */
export interface ForwardRuleRow {
  id: number;
  partner: string;
  route: string;
  transport: string;
  enabled: boolean;
}
export function listForwardRules(): Promise<{ rules: ForwardRuleRow[] }> {
  return call(`/api/bbs/forward`);
}
export function saveForwardRule(r: {
  partner: string;
  route: string;
  transport?: string;
}): Promise<{ ok: boolean; id: number }> {
  return call(`/api/bbs/forward`, { method: "POST", body: JSON.stringify(r) });
}
export function deleteForwardRule(id: number): Promise<{ ok: boolean }> {
  return call(`/api/bbs/forward/${id}`, { method: "DELETE" });
}

// ---- audio-cache: staged multi-cache ----
import type { CacheStage } from "@aprscaching/shared";
export type { CacheStage };
export function getStages(cacheId: number, callsign?: string): Promise<{ stages: CacheStage[] }> {
  return call(`/api/caches/${cacheId}/stages${callsign ? `?callsign=${encodeURIComponent(callsign)}` : ""}`);
}
export function unlockStage(
  cacheId: number,
  stageNo: number,
  callsign: string,
  appGeo?: AppGeo,
  code?: string,
): Promise<{ unlocked: boolean; lat?: number; lon?: number; reason?: string; distanceM?: number }> {
  return call(`/api/caches/${cacheId}/stages/${stageNo}/unlock`, {
    method: "POST",
    body: JSON.stringify({ callsign, appGeo, code }),
  });
}
export function setStages(
  cacheId: number,
  ownerCall: string,
  stages: Array<Partial<CacheStage> & { stageNo: number; secret?: string }>,
): Promise<{ ok: boolean }> {
  return call(`/api/caches/${cacheId}/stages`, { method: "POST", body: JSON.stringify({ ownerCall, stages }) });
}
/** Absolute URL for a media clue path returned by the API. */
export const mediaUrl = (path: string): string => API_BASE + path;

// ---- cache media gallery: owner-managed photos/audio/files on a cache ----
export interface CacheMediaItem {
  id: number;
  kind: "image" | "audio" | "file";
  contentType: string;
  title: string | null;
  url: string;
  bytes: number;
  createdAt?: number;
}
/** A cache's media; without a connection, the images its offline pack keeps, as local object URLs. */
export async function getCacheMedia(cacheId: number): Promise<{ media: CacheMediaItem[] }> {
  try {
    return await call(`/api/caches/${cacheId}/media`);
  } catch (e) {
    if (!isOffline(e)) throw e;
    const st = await offlineReady();
    const hit = await packCache(st, cacheId);
    if (!hit) throw e;
    const media: CacheMediaItem[] = [];
    for (const img of hit.cache.images)
      for (const option of ["full", "thumbs"] as const) {
        const blob = await st.blob(hit.pack.id, imageKey(img, option));
        if (!blob) continue;
        media.push({
          id: img.id,
          kind: "image",
          contentType: blob.type || img.contentType,
          title: img.title,
          url: URL.createObjectURL(blob),
          bytes: blob.size,
        });
        break;
      }
    return { media };
  }
}
/** Upload a media item (raw body) — authorised by the signed-in owner session. */
export async function addCacheMedia(cacheId: number, file: File, title?: string): Promise<{ item: CacheMediaItem }> {
  const q = title ? `?title=${encodeURIComponent(title)}` : "";
  const res = await reach(`${API_BASE}/api/caches/${cacheId}/media${q}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  const body = (await res.json().catch(() => ({}))) as { item?: CacheMediaItem; error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body as { item: CacheMediaItem };
}
export function deleteCacheMedia(cacheId: number, mediaId: number): Promise<{ ok: boolean }> {
  return call(`/api/caches/${cacheId}/media/${mediaId}`, { method: "DELETE" });
}

// ---- per-cache share funnel: print a QR on your station so visitors can find it ----
/** The public deep-link a QR encodes (opens the cache in the app — the current origin). */
export const cacheShareUrl = (code: string): string =>
  `${typeof window !== "undefined" ? window.location.origin : ""}/?cache=${encodeURIComponent(code)}`;
/** An SVG QR for the cache's share link, served by the gateway embed surface. */
export const cacheQrUrl = (code: string, size = 256): string =>
  `${API_BASE}/embed/qr.svg?cache=${encodeURIComponent(code)}&size=${size}`;

// ---- BBS store-and-forward ----
import type { BbsMessage } from "@aprscaching/shared";
export type { BbsMessage };
export function getBbsInbox(callsign: string): Promise<{ messages: BbsMessage[] }> {
  return call(`/api/bbs/messages?to=${encodeURIComponent(callsign)}`);
}
export function getBulletins(): Promise<{ bulletins: BbsMessage[] }> {
  return call(`/api/bbs/bulletins`);
}
export function postBbsMessage(body: {
  fromCall: string;
  toCall: string;
  subject?: string;
  body: string;
  type?: "P" | "B" | "T";
  replyTo?: number;
}): Promise<{ ok: boolean; id: number; type: string; threadId?: number }> {
  return call(`/api/bbs/messages`, { method: "POST", body: JSON.stringify(body) });
}
// ---- NET/ROM node read surface ----
export interface NodeRouteRow {
  dest: string;
  alias: string;
  neighbor: string;
  quality: number;
  port: string | null;
}
export interface MheardRow {
  callsign: string;
  port: string;
  lastHeard: number;
  count: number;
}
export function getNodes(): Promise<{ nodes: NodeRouteRow[] }> {
  return call(`/api/node/nodes`);
}

// ---- FBB forwarding partners — sysop transport-level partner config ----
export interface ForwardPartner {
  id: number;
  call: string;
  ha: string | null;
  connectScript: string;
  proto: "rf-fbb" | "axudp" | "ip-fed";
  intervalMin: number;
  timebands: string;
  requestReverse: boolean;
  msgtypes: string;
  maxBlock: number;
  enabled: boolean;
}
export function listForwardPartners(): Promise<{ partners: ForwardPartner[] }> {
  return call(`/api/bbs/partners`);
}
export function saveForwardPartner(
  p: Partial<ForwardPartner> & { call: string },
): Promise<{ ok: boolean; partner: ForwardPartner }> {
  return call(`/api/bbs/partners`, { method: "POST", body: JSON.stringify(p) });
}
export function deleteForwardPartner(id: number): Promise<{ ok: boolean }> {
  return call(`/api/bbs/partners/${id}`, { method: "DELETE" });
}
export function getMheard(limit = 50): Promise<{ mheard: MheardRow[] }> {
  return call(`/api/node/mheard?limit=${limit}`);
}
/** Personal mail you SENT, with its store-and-forward delivery state. */
export function getBbsSent(callsign: string): Promise<{ messages: BbsMessage[] }> {
  return call(`/api/bbs/sent?from=${encodeURIComponent(callsign)}`);
}
/** Mark a personal message read (clears its unread state). */
export function markBbsRead(id: number): Promise<{ ok: boolean }> {
  return call(`/api/bbs/messages/${id}/read`, { method: "POST" });
}

// ---- account data lifecycle (GDPR) ----
type SignedAction = { key: string; sig: string; at: number };
export function exportAccount(callsign: string, auth: SignedAction): Promise<Record<string, unknown>> {
  return call(`/api/account/${encodeURIComponent(callsign)}/export`, { method: "POST", body: JSON.stringify(auth) });
}
export function deleteAccount(callsign: string, auth: SignedAction): Promise<{ ok: boolean; erased: string }> {
  return call(`/api/account/${encodeURIComponent(callsign)}/delete`, { method: "POST", body: JSON.stringify(auth) });
}

export function createCache(body: CreateCacheRequest): Promise<{ cache: CacheSummary }> {
  return call(`/api/caches`, { method: "POST", body: JSON.stringify(body) });
}

export interface LogResult {
  logged: boolean;
  logType: LogType;
  accountVerified: boolean;
  verified: boolean;
  tier?: TrustTier;
  method?: string;
  distanceM?: number;
  reason?: string;
  announced?: boolean;
  corroboratedBy?: string | null; // peer instance that granted Tier A
  signerKey?: string | null; // device key that signed the find
  queued?: boolean; // saved offline, will sync when connectivity returns
  duplicate?: boolean; // this callsign had already logged the cache; the first find stands unchanged
}

export interface AuthorSig {
  authorKey: string;
  authorSig: string;
  signedAt: number;
}
export type LogBody = { loggerCall: string; logType: LogType; comment?: string; appGeo?: AppGeo; author?: AuthorSig };

// ---- offline-tolerant logging: queue a log if the network is down, sync when back (log/logQueue.ts) ----
// The queue lives in the offline store (IndexedDB), where the service worker can reach it as well.
const queueStore: QueueStore = {
  get: async (k) => (await offlineReady()).kvGet(k),
  set: async (k, v) => (await offlineReady()).kvSet(k, v),
};
const isOffline = (e: unknown) => !navigator.onLine || e instanceof TypeError; // fetch network errors throw TypeError
const queueChanged = () => {
  try {
    window.dispatchEvent(new Event("acs-queued"));
  } catch {
    /* ssr */
  }
};

/** Log against a cache; with no connection the log is queued (signed and timed now) and sent later. */
export function logFind(cacheId: number, body: LogBody, label?: string): Promise<LogResult> {
  return call<LogResult>(`/api/caches/${cacheId}/logs`, { method: "POST", body: JSON.stringify(body) }).catch(
    async (e) => {
      if (!isOffline(e)) throw e;
      await enqueue(queueStore, { cacheId, body, ...(label && { label }) }, Date.now());
      queueChanged();
      return { logged: true, queued: true, logType: body.logType, accountVerified: false, verified: false };
    },
  );
}

export const queuedLogs = (): Promise<QueuedLog<LogBody>[]> => loadQueue<LogBody>(queueStore);
export const attentionLogs = (): Promise<AttentionLog<LogBody>[]> => loadAttention<LogBody>(queueStore);

/**
 * Send the queued logs that are due (the signature and its time are kept, so the instance verifies each
 * at the time it was made). A refused log moves to needs-attention, never away.
 */
export async function flushLogQueue(): Promise<FlushResult> {
  if (!(await queuedLogs()).length) return { sent: 0, refused: 0 };
  const res = await flush<LogBody>(
    queueStore,
    async (it) => {
      try {
        await call(`/api/caches/${it.cacheId}/logs`, {
          method: "POST",
          body: JSON.stringify({ ...it.body, offline: true }),
        });
      } catch (e) {
        if (isOffline(e)) throw { kind: "offline" } satisfies SendFailure;
        const status = e instanceof ApiError ? e.status : 0;
        if (status === 0 || status >= 500 || status === 408 || status === 429)
          throw { kind: "retry" } satisfies SendFailure;
        throw { kind: "refused", status, reason: (e as Error).message } satisfies SendFailure;
      }
    },
    Date.now(),
  );
  if (res.sent || res.refused) queueChanged();
  return res;
}

/** Queue a refused log again (optionally with a new comment) and try it at once. */
export async function retryAttentionLog(index: number, comment?: string): Promise<FlushResult> {
  await retryAttention(queueStore, index, Date.now(), comment);
  queueChanged();
  return flushLogQueue();
}
/** Remove a refused log for good. */
export async function discardAttentionLog(index: number): Promise<void> {
  await discardAttention(queueStore, index);
  queueChanged();
}

export function registerKey(body: { callsign: string; publicKey: string; label?: string }): Promise<{ ok: boolean }> {
  return call(`/keys/register`, { method: "POST", body: JSON.stringify(body) });
}

/**
 * Callsign control-verification. Starting issues a code and names the message to transmit: `text` sent to
 * `to` from the call (any SSID) over RF, heard by this instance's attested receiving site. Nothing is sent
 * for the user. Verify the BASE call (SSIDs inherit); poll {@link getVerifyStatus} for the result.
 */
export interface VerifyChallenge {
  code: string;
  to: string;
  text: string;
  /** Unix seconds after which the code no longer verifies. */
  expiresAt: number;
  /** The receiving-site calls listening for the message. */
  sites?: string[];
}
export function startAprsVerify(callsign: string): Promise<VerifyChallenge> {
  return call(`/verify/aprs/start`, { method: "POST", body: JSON.stringify({ callsign }) });
}
export function getVerifyStatus(callsign: string): Promise<{ verified: boolean }> {
  return call(`/verify/aprs/status?callsign=${encodeURIComponent(callsign)}`);
}

/**
 * Which verification methods this instance offers: on the air needs an attested receiving site (`rfSites`
 * names them), LoTW needs the operator's trusted LoTW CA.
 */
export interface VerifyMethods {
  methods: { rf_heard: boolean; ampr_dns: boolean; lotw: boolean };
  rfSites?: string[];
}
export function getVerifyMethods(): Promise<VerifyMethods> {
  return call(`/verify/methods`);
}

/** An ampr.org DNS challenge: publish `record` (name, TXT, value) under the call's ampr.org name. */
export interface AmprChallenge {
  code: string;
  name: string;
  value: string;
  record: string;
  expiresAt: number;
}
export function startAmprVerify(callsign: string): Promise<AmprChallenge> {
  return call(`/verify/ampr/start`, { method: "POST", body: JSON.stringify({ callsign }) });
}
/** Look the published record up; rejects with the server's reason when it does not verify. */
export function checkAmprVerify(callsign: string): Promise<{ verified: boolean; method: string }> {
  return call(`/verify/ampr/check`, { method: "POST", body: JSON.stringify({ callsign }) });
}

/** A LoTW challenge: the exact `message` to sign with the callsign certificate's key. */
export interface LotwChallenge {
  challenge: string;
  message: string;
  expiresAt: number;
}
export function startLotwVerify(callsign: string): Promise<LotwChallenge> {
  return call(`/verify/lotw/start`, { method: "POST", body: JSON.stringify({ callsign }) });
}
export function completeLotwVerify(
  callsign: string,
  proof: { certificates: string[]; signature: string },
): Promise<{ verified: boolean; method: string }> {
  return call(`/verify/lotw/complete`, { method: "POST", body: JSON.stringify({ callsign, ...proof }) });
}

// ---- auth: session, passkey ceremonies, email magic-link ----
export type Session = { callsign: string | null; verified?: boolean; email?: string | null };
export function getSession(): Promise<Session> {
  return call(`/auth/session`);
}
export function logout(): Promise<{ ok: boolean }> {
  return call(`/auth/logout`, { method: "POST" });
}
/** End every session of the signed-in account, on every device. */
export function logoutAll(): Promise<{ ok: boolean }> {
  return call(`/auth/logout-all`, { method: "POST" });
}
export function claim(
  callsign: string,
): Promise<{ callsign: string; exists: boolean; hasPasskey: boolean; licence?: Licence }> {
  return call(`/auth/claim`, { method: "POST", body: JSON.stringify({ callsign }) });
}
export function emailStart(
  email: string,
  callsign?: string,
): Promise<{ sent: boolean; purpose: string; devLink?: string }> {
  return call(`/auth/email/start`, { method: "POST", body: JSON.stringify({ email, callsign }) });
}
/** Switch the signed-in account's active callsign. Switching to a held call preserves its
 *  verification; switching to a new base call adds it (unverified). */
export function changeCallsign(callsign: string): Promise<{ ok: boolean; callsign: string; verified: boolean }> {
  return call(`/auth/callsign`, { method: "POST", body: JSON.stringify({ callsign }) });
}
/** Callsign validity from the public licence registers this instance imports. It flags, never gates:
 *  "unconfirmed" means no imported register lists the call (many countries publish none). Distinct from
 *  `verified`, which is control-verification. */
export type Licence = {
  callsign: string;
  status: "licensed" | "expired" | "unconfirmed";
  source?: string;
  sourceName?: string;
  expiresAt?: number;
  checkedAt?: number;
};
/** Look a callsign up in the imported public licence registers. */
export function getLicence(callsign: string): Promise<Licence> {
  return call(`/api/licence/${encodeURIComponent(callsign)}`);
}
export type HeldCallsign = {
  callsign: string;
  verified: boolean;
  isPrimary: boolean;
  active: boolean;
  licence?: Licence;
};
/** The base callsigns this account holds, with verification + which is active/primary. */
export function listCallsigns(): Promise<{ active: string; callsigns: HeldCallsign[] }> {
  return call(`/auth/callsigns`);
}
/** Add another base callsign to the account (held + unverified; does not switch the active call). */
export function addCallsign(
  callsign: string,
): Promise<{ ok: boolean; callsign: string; verified: boolean; licence?: Licence }> {
  return call(`/auth/callsigns`, { method: "POST", body: JSON.stringify({ callsign }) });
}

export async function registerPasskey(callsign: string, email?: string): Promise<{ ok: boolean; callsign: string }> {
  const o = await call<any>(`/auth/passkey/register/begin`, {
    method: "POST",
    body: JSON.stringify({ callsign, email }),
  });
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: fromB64u(o.challenge),
      rp: o.rp,
      user: { id: fromB64u(o.user.id), name: o.user.name, displayName: o.user.displayName },
      pubKeyCredParams: o.pubKeyCredParams,
      timeout: o.timeout,
      attestation: o.attestation,
      authenticatorSelection: o.authenticatorSelection,
      excludeCredentials: (o.excludeCredentials ?? []).map((c: any) => ({ type: c.type, id: fromB64u(c.id) })),
    },
  })) as PublicKeyCredential;
  const r = cred.response as AuthenticatorAttestationResponse;
  return call(`/auth/passkey/register/finish`, {
    method: "POST",
    body: JSON.stringify({
      callsign,
      credential: {
        id: cred.id,
        response: {
          clientDataJSON: toB64u(r.clientDataJSON),
          attestationObject: toB64u(r.attestationObject),
          transports: r.getTransports?.() ?? [],
        },
      },
    }),
  });
}
export async function loginPasskey(callsign: string): Promise<{ ok: boolean; callsign: string }> {
  const o = await call<any>(`/auth/passkey/login/begin`, { method: "POST", body: JSON.stringify({ callsign }) });
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: fromB64u(o.challenge),
      rpId: o.rpId,
      timeout: o.timeout,
      userVerification: o.userVerification,
      allowCredentials: (o.allowCredentials ?? []).map((c: any) => ({ type: c.type, id: fromB64u(c.id) })),
    },
  })) as PublicKeyCredential;
  const r = cred.response as AuthenticatorAssertionResponse;
  return call(`/auth/passkey/login/finish`, {
    method: "POST",
    body: JSON.stringify({
      callsign,
      credential: {
        id: cred.id,
        response: {
          clientDataJSON: toB64u(r.clientDataJSON),
          authenticatorData: toB64u(r.authenticatorData),
          signature: toB64u(r.signature),
        },
      },
    }),
  });
}

let instanceCache: Promise<string> | null = null;
const INSTANCE_KEY = "acs.instance";
/**
 * This instance's federation id, used to build the canonical authorship message. It is remembered once
 * known, so a log made offline is still signed for its instance; a failed lookup is not cached.
 */
export function getInstance(): Promise<string> {
  if (!instanceCache)
    instanceCache = call<{ instance: string }>(`/.well-known/aprscaching`)
      .then((d) => {
        try {
          localStorage.setItem(INSTANCE_KEY, d.instance);
        } catch {
          /* storage unavailable */
        }
        return d.instance;
      })
      .catch(() => {
        instanceCache = null; // ask again next time instead of remembering the failure
        try {
          return localStorage.getItem(INSTANCE_KEY) ?? "";
        } catch {
          return "";
        }
      });
  return instanceCache;
}

/** AGPL §13: the source the running instance reports, + the redirect link to it. */
export type SourceInfo = {
  repo: string;
  commit: string | null;
  tag: string | null;
  builtAt: number | null;
  license: string;
};
export function getSource(): Promise<SourceInfo> {
  return call<SourceInfo>(`/.well-known/source`);
}
export const sourceLinkUrl = `${API_BASE}/source`;
