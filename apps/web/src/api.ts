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
  removeQueued,
} from "./log/logQueue.js";
import type {
  CacheSummary,
  CacheDetail,
  CacheLogEntry,
  CreateCacheRequest,
  UpdateCacheRequest,
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
  MeshcomGroup,
  MeshcomGroupMessage,
  Spot,
} from "@aprscaching/shared";

export type {
  CacheSummary,
  CacheDetail,
  CacheLogEntry,
  CreateCacheRequest,
  UpdateCacheRequest,
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
  MeshcomGroup,
  MeshcomGroupMessage,
  Spot,
};
import { PHOTO_PX, resizeImage, thumbnailOf } from "./media/resize.js";
import { openSealedStage, type StagePayload, type ToolRegistryEntry } from "@aprscaching/shared";
import { offlineStore, type OfflineStore } from "./offline/store.js";
import { packCache, packCachesInBox, packSearch, saveAutoArea, type OfflineSource } from "./offline/packs.js";
import { imageKey } from "./offline/download.js";
import { fromB64u, toB64u } from "./base64url.js";
import { stageRefusalText } from "./log/stageUnlock.js";
import { mediaUploadProblem } from "./media/limits.js";

/** Drop trailing `/` from a URL without a regex (the URL can be typed by the user). */
export function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end--;
  return url.slice(0, end);
}

/**
 * Gateway base URL. Without `VITE_API_BASE` the app talks to its own origin (`""`), which is right wherever
 * one host serves both the SPA and the API (the desktop binary, a Pi, an all-in-one VM, and the dev server,
 * which proxies the gateway's paths to a local gateway) and fails visibly anywhere else — never a silent
 * localhost that only answers on the builder's machine. A web app served from another host than its
 * gateway sets `VITE_API_BASE` at build time.
 */
export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

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

/** Why a cache did not load: the server's own reason when it answered that the cache is gone (removed, or
 *  never there), otherwise `fallback`, which points at the connection. */
export function cacheLoadText(e: unknown, fallback: string): string {
  return e instanceof ApiError && (e.status === 404 || e.status === 410) ? errorText(e) : fallback;
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

export async function call<T>(path: string, init?: RequestInit): Promise<T> {
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

/** The offline store (offline/store.ts): the packs and the log queue. */
export const offlineReady = (): Promise<OfflineStore> => Promise.resolve(offlineStore());
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
      .then((st) => saveAutoArea(st, r.caches, knownInstance(), Date.now()))
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
      sourceOwner: c.sourceOwner,
      sourceAttribution: c.sourceAttribution,
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

/** The windows the leaderboard counts over: every find, or those of the last 365 or 30 days. */
export type RankPeriod = "all" | "year" | "month";
export function getLeaderboard(
  bbox: BBox,
  metric: "finds" | "points",
  period: RankPeriod = "all",
): Promise<{ leaderboard: LeaderboardEntry[] }> {
  return call(`/api/leaderboard?metric=${metric}&period=${period}&bbox=${bbox.join(",")}`);
}
/** The absolute address of a callsign's embeddable badge, `/badge/<call>.svg`, wherever the API is served. */
export function badgeUrl(callsign: string): string {
  return new URL(`/badge/${encodeURIComponent(callsign)}.svg`, API_BASE || location.origin).href;
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
/** The signed-in account's own profile: every field, also while hidden, and the show/hide switch. */
export function getMyProfile(): Promise<{
  profile: {
    displayName: string | null;
    homeGrid: string | null;
    avatarUrl: string | null;
    bio: string | null;
    links: { label: string; url: string }[];
    publicContact: string | null;
    profilePublic: boolean;
  };
}> {
  return call(`/api/my/profile`);
}
/** The signed-in account's hides in the last 24 hours; `limit` and `remaining` are null when no limit applies. */
export function getMyHides(): Promise<{ limit: number | null; used: number; remaining: number | null }> {
  return call(`/api/my/hides`);
}
/** The caches the signed-in person found, logged as a did-not-find, or hid (cache ids). */
export function getMyLogged(): Promise<{ found: number[]; dnf: number[]; owned: number[] }> {
  return call(`/api/my/logged`);
}
export function getProfile(callsign: string): Promise<Profile> {
  return call(`/api/profile/${encodeURIComponent(callsign)}`);
}
import type { SearchResults } from "@aprscaching/shared";
export type { SearchResults, SearchHitCache, SearchHitStation } from "@aprscaching/shared";
/** Enriched as-you-type suggestions across caches + stations; without a connection, the offline packs' caches. */
export async function searchSuggest(q: string, signal?: AbortSignal, limit = 8): Promise<SearchResults> {
  try {
    return await call<SearchResults>(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`, { signal });
  } catch (e) {
    if (!isOffline(e)) throw e;
    return { caches: await packSearch(await offlineReady(), q, limit), stations: [] };
  }
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
/** The MeshCom groups this instance's nodes heard within the message retention, most recently active first. */
export function getMeshcomGroups(): Promise<{ groups: MeshcomGroup[] }> {
  return call("/api/meshcom/groups");
}
/** One MeshCom group's messages, newest first. */
export function getMeshcomGroupMessages(
  group: string,
  cursor?: string | null,
  limit = 30,
): Promise<{ group: string; messages: MeshcomGroupMessage[] } & PageInfo> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (cursor) q.set("cursor", cursor);
  return call(`/api/meshcom/groups/${encodeURIComponent(group)}/messages?${q.toString()}`);
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
/** The read API's file exports, as paths under `/api/v1`. */
export const exportPath = {
  cachesGpx: (bbox: [number, number, number, number]) => `/api/v1/caches.gpx?bbox=${bbox.join(",")}`,
  cachesKml: (bbox: [number, number, number, number]) => `/api/v1/caches.kml?bbox=${bbox.join(",")}`,
  cacheGpx: (code: string) => `/api/v1/caches/${encodeURIComponent(code)}.gpx`,
  findsAdif: (call: string) => `/api/v1/profile/${encodeURIComponent(call)}.adif`,
  stationKml: (call: string) => `/api/v1/station/${encodeURIComponent(call)}.kml`,
};

/**
 * Save a read-API export as a file. The app fetches it and saves the local copy, so a failure (the rate limit,
 * a box too large) reaches the caller as an error instead of a page the browser opens.
 */
export async function downloadExport(path: string, filename: string): Promise<void> {
  const res = await reach(API_BASE + path);
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => null);
    const msg = (data as { error?: string } | null)?.error;
    throw new ApiError(
      res.status === 429 ? "Too many downloads — wait a minute and try again" : (msg ?? `${res.status}`),
      res.status,
      data,
    );
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function decodePacket(raw: string): Promise<DecodedPacket> {
  return call(`/api/decode`, { method: "POST", body: JSON.stringify({ raw }) });
}
export function getPorts(): Promise<{ window: string; ports: PortStat[] }> {
  return call(`/api/ports`);
}
/** Record an APRS message this browser's radio sent, so the Messages list shows it as sent. */
/** A Mailbox message: held for a callsign until its station is heard, then sent to it on the air. */
export interface MailboxMessage {
  id: number;
  from: string;
  to: string;
  text: string;
  via: "app" | "radio";
  status: "held" | "sent" | "delivered" | "undelivered" | "expired";
  deliveredTo: string | null;
  createdAt: number;
  expiresAt: number;
  deliveredAt: number | null;
  attempts: number;
}
/** The messages you left, and those waiting for any of your calls. */
export function getMailbox(): Promise<{ sent: MailboxMessage[]; received: MailboxMessage[] }> {
  return call("/api/mailbox");
}
/** Leave a message for `to`, signed with your verified call `from`. */
export function leaveMailboxMessage(from: string, to: string, text: string): Promise<{ ok: true; id: number }> {
  return call("/api/mailbox", { method: "POST", body: JSON.stringify({ from, to, text }) });
}
/** Withdraw a message you left that is still waiting. */
export function withdrawMailboxMessage(id: number): Promise<{ ok: true }> {
  return call(`/api/mailbox/${id}`, { method: "DELETE" });
}

/**
 * Send an APRS message now through the instance: it goes out on APRS-IS under your verified call, by way of the
 * instance's ingest box, and joins your conversation with its delivery state.
 */
export function sendAprsMessage(m: {
  to: string;
  text: string;
  msgNo?: string;
}): Promise<{ id: number; srcCall: string; status: "queued" }> {
  return call(`/api/tx/aprs`, {
    method: "POST",
    body: JSON.stringify({ kind: "message", addressee: m.to, text: m.text, msgNo: m.msgNo }),
  });
}

export function recordSentMessage(m: {
  from: string;
  to: string;
  text: string;
  msgNo?: string;
}): Promise<{ ok: true }> {
  return call(`/api/messages/sent`, { method: "POST", body: JSON.stringify(m) });
}
export function getMessages(
  bulletins = false,
  cursor?: string | null,
  limit = 30,
  to?: string,
  /** only this operator's traffic, under any SSID of its base call */
  ofCall?: string,
): Promise<{ messages: MessageItem[]; serviceCall?: string } & PageInfo> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (bulletins) q.set("bulletins", "1");
  if (to) q.set("to", to);
  if (ofCall) q.set("call", ofCall);
  if (cursor) q.set("cursor", cursor);
  return call(`/api/messages?${q.toString()}`);
}

// ---- logs sent over the air (FOUND / DNF / NOTE radio messages) ----
export interface RadioCommandRow {
  id: number;
  fromCall: string;
  command: "found" | "dnf" | "note" | "mail" | "near" | "help" | "invalid";
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
  status: "queued" | "sent" | "done" | "failed" | "expired";
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
  /** The alert kind (shack/alertKinds.ts): a watched station, or a notice about the account. */
  kind: string;
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
// ---- weather user-origination: a weather station in My stations ----
/** Submit one in-browser-decoded PWS reading to the direct PWS ingest, using the station's key.
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
/** Toggle a weather station's APRS-IS weather beacon / CWOP relay. */
export function setWxTx(body: { stationId: number; txIs: boolean; txCwop: boolean }): Promise<WxTxState> {
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
/** The sysop lists a station for a member (a club station run by someone who does not hold the club call). */
export function adminAddStation(s: {
  owner: string;
  callsign: string;
  lat?: number;
  lon?: number;
}): Promise<{ station: OperatedStation }> {
  return call(`/api/admin/stations`, { method: "POST", body: JSON.stringify(s) });
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
/** Whether the signed-in account announces its verified finds on APRS-IS. */
export function getAnnounce(): Promise<{ on: boolean }> {
  return call(`/api/announce`);
}
export function setAnnounce(on: boolean): Promise<{ on: boolean }> {
  return call(`/api/announce`, { method: "POST", body: JSON.stringify({ on }) });
}
/** Whether the service call messages the signed-in account's stations when they are heard near a cache. */
export function getNearRadio(): Promise<{ on: boolean }> {
  return call(`/api/near-radio`);
}
export function setNearRadio(on: boolean): Promise<{ on: boolean }> {
  return call(`/api/near-radio`, { method: "POST", body: JSON.stringify({ on }) });
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
  /** The pinned key's fingerprint (four groups of four hex digits); null until a signed sync pins a key */
  fingerprint: string | null;
  trust: "trusted" | "unvetted" | "blocked";
  added_via?: string | null; // manual | admin | registry | discovered | mdns | submitted | 44net | transit
  /** When corroboration raised it to trusted on its own (FED_AUTO_PROMOTE); null once the sysop decides */
  auto_promoted_at?: number | null;
  /** 0 for a discovered peer the operator has not enabled yet: it is listed but never synced */
  enabled: number;
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
  /** the fingerprint a FED_PEERS entry pins (`<url>#<fingerprint>`) */
  pinned_fingerprint: string | null;
  /** listed in FED_PEERS, so it is removed there rather than here */
  configured: boolean;
  /** when this peer last pushed to us (a spoke), and when we last pushed to it (our hub) */
  last_push_in: number | null;
  last_push_out: number | null;
  /** How discovery heard of it: a trusted peer's list or an mDNS announcement; null when nothing lists it */
  discovery: FedDiscovery | null;
  /** the last pull over a packet circuit, which the ingest box dials: the endpoint it used and how it went */
  packet: {
    transport: "ax25" | "netrom";
    address: string;
    lastAttempt: number;
    lastOk: number | null;
    lastError: string | null;
  } | null;
}
/** The sources that listed a peer, with the key fingerprint each gave, and the addresses learned. */
export interface FedDiscovery {
  /** `via` is the listing peer's instance id, or `mdns` for an announcement on this network */
  sightings: { via: string; fingerprint: string | null; at: number; address?: string }[];
  addresses: string[];
  onThisNetwork: boolean;
  /** a source gave a fingerprint other than the pinned key's, or two sources disagree */
  keyMismatch: boolean;
}
/** A row only discovery brought: listed, switched off and unvetted until the sysop follows it. */
export function isDiscoveredPeer(p: FedPeer): boolean {
  return (
    p.trust === "unvetted" &&
    !Number(p.enabled) &&
    (p.url.startsWith("discovered:") || (p.added_via === "transit" && !!p.discovery))
  );
}
export function listFederationPeers(): Promise<{
  /** This instance and its own key fingerprint (null when it signs nothing) */
  self: {
    instance: string | null;
    fingerprint: string | null;
    /** FED_DISCOVER, FED_PEER_EXCHANGE and the mDNS mode this server runs */
    discovery?: { learn: boolean; lists: boolean; mdns: "off" | "listen" | "announce" };
  };
  peers: FedPeer[];
  /** Records no neighbour filled within a week, given up and not marked seen yet */
  givenUp?: { count: number; gaps: FedGivenUp[] };
}> {
  return call(`/federation/peers`);
}

/** A record of another instance this one asked its neighbours for, for a week, and gave up on. */
export interface FedGivenUp {
  origin: string;
  kind: "cache" | "find" | "tombstone" | "account-move";
  /** The record's number in its home instance's sequence */
  v: number;
  /** unsettled: it arrived but would not apply or verify; hops: it crossed too many instances; upstream: a neighbour lacked it */
  reason: "unsettled" | "hops" | "upstream";
  firstSeen: number;
  givenUp: number;
}
/** Operator: the given-up records have been seen; they leave the list. */
export function markGivenUpSeen(): Promise<{ ok: boolean; seen: number }> {
  return call(`/federation/gaps/seen`, { method: "POST", body: "{}" });
}

/** What looking a would-be peer up by its address shows, before anything is stored. */
export interface FedPeerPreview {
  url: string;
  instance: string;
  fingerprint: string;
  operator: string | null;
}
/** Operator: fetch a would-be peer's descriptor and show its instance and key fingerprint (sysop-gated). */
export function lookUpPeer(url: string): Promise<{ preview: FedPeerPreview }> {
  return call(`/federation/peers`, { method: "POST", body: JSON.stringify({ url }) });
}
/** Operator: add the peer just looked up, unvetted, pinning the key whose fingerprint was compared. */
export function addPeer(
  url: string,
  fingerprint: string,
): Promise<{ ok: boolean; peer: FedPeerPreview & { trust: string } }> {
  return call(`/federation/peers`, { method: "POST", body: JSON.stringify({ url, fingerprint }) });
}
/**
 * Operator: follow a discovered instance. The gateway fetches its key and refuses one that differs from what its
 * sources listed or from a key already pinned. With `fingerprint`, the sysop compared it and it is trusted at once.
 */
export function followPeer(
  url: string,
  fingerprint?: string,
): Promise<{ ok: boolean; peer: FedPeerPreview & { trust: string } }> {
  return call(`/federation/peers/follow`, {
    method: "POST",
    body: JSON.stringify({ url, ...(fingerprint && { trust: true, fingerprint }) }),
  });
}
/** Operator: remove a peer and its pinned key. */
export function removePeer(url: string): Promise<{ ok: boolean }> {
  return call(`/federation/peers?url=${encodeURIComponent(url)}`, { method: "DELETE" });
}

/** What one peer's Sync now brought: the records per feed, or the pull's error, and its last pull times. */
export interface PeerSyncResult {
  ok: boolean;
  url: string;
  pulled?: {
    caches: number;
    finds: number;
    keys: number;
    tombstones: number;
    moves: number;
    bulletins: number;
    /** Records the peer passed on from other instances. */
    transit: number;
  };
  error?: string;
  lastSync: number | null;
  lastOk: number | null;
  lastError: string | null;
}

/** Sync now, one peer: pull from it at once (sysop, rate limited per peer). */
export function syncPeerNow(url: string): Promise<PeerSyncResult> {
  return call(`/federation/peers/sync`, { method: "POST", body: JSON.stringify({ url }) });
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
/**
 * Operator: promote/demote/quarantine a federation peer (sysop-gated). Trusting takes the fingerprint the sysop
 * compared, and the server refuses it when the pinned key is another.
 */
export function setPeerTrust(
  url: string,
  trust: "trusted" | "unvetted" | "blocked",
  fingerprint?: string,
): Promise<{ ok: boolean }> {
  return call(`/federation/peers/trust`, { method: "POST", body: JSON.stringify({ url, trust, fingerprint }) });
}

export interface Fed44netResolved {
  callsign: string;
  /** The 44Net name the peer is reached at, or null when it publishes an https origin only. */
  host: string | null;
  /** The https origin the peer is reached at, or null on 44Net only. */
  web: string | null;
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
/** Who to add by callsign: a callsign (`_aprscaching.<call>.ampr.org`) or a host in its zone (`_aprscaching.<host>`). */
export type Fed44netTarget = { callsign: string } | { host: string };
/** The bindings an ambiguous lookup found, carried by its 409 refusal; one with a host is added by it. */
export type Fed44netCandidate = { instance: string; host: string | null; web: string | null };
/**
 * Operator: add a peer by its ARDC-verified `<call>.ampr.org` binding (sysop-gated), over 44Net, https or both. A
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
  /** the peer instances this instance names (FED_PEERS) */
  peers?: string[];
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
/** Verify a call by hand for the account the sysop looked at (`holder`, null when nobody holds the call). */
export function addManualVerification(
  callsign: string,
  note: string,
  holder: string | null,
): Promise<{ verified: boolean; callsign: string }> {
  return call(`/api/admin/verifications`, { method: "POST", body: JSON.stringify({ callsign, note, holder }) });
}
/** The sysop's view of a call: who holds it, how it is verified, open claims, and its holder-change trail. */
export interface CallsignView {
  callsign: string;
  adminCall: boolean;
  holder: {
    accountId: string;
    activeCallsign: string;
    passkeys: number;
    email: boolean;
    createdAt: number;
    held: { callsign: string; isPrimary: boolean }[];
  } | null;
  verification: {
    method: string | null;
    verifiedAt: number | null;
    verifiedBy: string | null;
    note: string | null;
  } | null;
  openClaims: number;
  events: {
    action: "claimed" | "released";
    fromAccount: string | null;
    toAccount: string | null;
    actor: string;
    note: string | null;
    at: number;
  }[];
}
export function lookupCallsign(callsign: string): Promise<CallsignView> {
  return call(`/api/admin/callsigns/${encodeURIComponent(callsign)}`);
}
/** Detach a call from the account the sysop looked at (`holder`), with the reason. */
export function releaseCallsign(callsign: string, reason: string, holder: string): Promise<{ released: boolean }> {
  return call(`/api/admin/callsigns/${encodeURIComponent(callsign)}`, {
    method: "POST",
    body: JSON.stringify({ action: "release", reason, holder }),
  });
}
export function revokeManualVerification(callsign: string): Promise<{ revoked: boolean }> {
  return call(`/api/admin/verifications/${encodeURIComponent(callsign)}`, { method: "DELETE" });
}
// ---- read-API keys ----
/** A read-API key as its owner and the sysop see it: its name and prefix, never the key itself. */
export interface ApiKey {
  id: number;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}
/** The signed-in account's read-API keys and how many it may hold. */
export function listApiKeys(): Promise<{ keys: ApiKey[]; cap: number }> {
  return call(`/api/keys`);
}
/** Create a key; the answer is the only time the full key is shown. */
export function createApiKey(name: string): Promise<ApiKey & { key: string }> {
  return call(`/api/keys`, { method: "POST", body: JSON.stringify({ name }) });
}
export function revokeApiKey(id: number): Promise<{ revoked: boolean }> {
  return call(`/api/keys/${id}`, { method: "DELETE" });
}
/** Every read-API key on the instance, with the owner's call (sysop). */
export function listAllApiKeys(): Promise<{ keys: (ApiKey & { owner: string | null })[]; cap: number }> {
  return call(`/api/admin/api-keys`);
}
export function adminRevokeApiKey(id: number): Promise<{ revoked: boolean }> {
  return call(`/api/admin/api-keys/${id}`, { method: "DELETE" });
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
  /** The sysop's trust in the box's receiving sites ("Trust this station's hearings"); null while off. */
  trust: BoxTrust | null;
  /** "Runs this instance's services": the box may serve the BBS mailbox, forwarding, the node mirror and the outbox. */
  services: boolean;
}
/** Who switched a box's trust on and when; trustedBy is an account id, or "operator" for the operator secret. */
export interface BoxTrust {
  sites: string[];
  trustedBy: string;
  trustedByCall: string | null;
  trustedAt: number;
}
/** The finds a trusted station verified at Tier A since it was trusted: the count and the most recent few. */
export interface BoxFinds {
  box: string;
  trust: BoxTrust | null;
  count: number;
  recent: { code: string; loggerCall: string; ts: number; site: string }[];
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
/** Switch "Trust this station's hearings" on for `sites`, or off. */
export function setBoxTrust(box: string, trusted: boolean, sites: string[] = []): Promise<{ trust: BoxTrust | null }> {
  return call(`/api/admin/boxes/${encodeURIComponent(box)}/trust`, {
    method: "POST",
    body: JSON.stringify(trusted ? { trusted, sites } : { trusted }),
  });
}
/** Switch "Runs this instance's services" on or off for one box. */
export function setBoxServices(box: string, services: boolean): Promise<{ services: boolean }> {
  return call(`/api/admin/boxes/${encodeURIComponent(box)}/services`, {
    method: "POST",
    body: JSON.stringify({ services }),
  });
}
export function getBoxFinds(box: string): Promise<BoxFinds> {
  return call(`/api/admin/boxes/${encodeURIComponent(box)}/finds`);
}
// ---- trusted receiving stations ----
/**
 * A receiving station whose direct hearings count for Radio-verified finds: preset in configuration
 * (FIRST_PARTY_SITES, read-only here), added by the sysop by its call, or trusted through its enrolled box.
 */
export interface TrustedStation {
  site: string;
  source: "config" | "admin" | "box";
  box?: string;
  boxLabel?: string | null;
  trustedBy: string | null;
  trustedByCall: string | null;
  trustedAt: number | null;
}
export function listTrustedStations(): Promise<{ sites: TrustedStation[] }> {
  return call(`/api/admin/sites`);
}
export function addTrustedStation(site: string): Promise<{ site: TrustedStation }> {
  return call(`/api/admin/sites`, { method: "POST", body: JSON.stringify({ site }) });
}
export function removeTrustedStation(site: string): Promise<{ removed: boolean }> {
  return call(`/api/admin/sites/${encodeURIComponent(site)}`, { method: "DELETE" });
}
export function getStationFinds(site: string): Promise<Omit<BoxFinds, "box" | "trust"> & { site: string }> {
  return call(`/api/admin/sites/${encodeURIComponent(site)}/finds`);
}

// ---- imported places (sysop)
export interface ImportedPlace {
  id: number;
  code: string;
  title: string;
  source: string;
  sourceName: string | null;
  externalId: string | null;
  status: string;
}
export interface RemovedListing {
  source: string;
  externalId: string;
  code: string | null;
  note: string | null;
  removedAt: number;
}
export function listImportedPlaces(q: string): Promise<{ places: ImportedPlace[]; removed: RemovedListing[] }> {
  return call(`/api/admin/imports?q=${encodeURIComponent(q)}`);
}
export function removeImportedPlace(id: number, note: string): Promise<{ removed: boolean; code: string }> {
  return call(`/api/admin/imports/${id}`, { method: "DELETE", body: JSON.stringify({ note }) });
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
/** The newest release against the running one, from the gateway's daily update check. */
export interface UpdateStatus {
  current: string;
  /** null until a check has answered */
  latest: string | null;
  url: string | null;
  checkedAt: number | null;
  available: boolean;
  /** the desktop app updates by replacing its binary */
  desktop: boolean;
}
export interface AdminSetup {
  items: SetupItem[];
  /** null when the operator turned the check off (UPDATE_CHECK=0) */
  update?: UpdateStatus | null;
}
export function getAdminSetup(): Promise<AdminSetup> {
  return call(`/api/admin/setup`);
}

/**
 * One instance setting as Instance admin → Instance settings shows it (the gateway's sitesettings.ts). `source`
 * says where `value` comes from: the environment (read-only here), a value saved here, or the default.
 */
export interface SiteSettingView {
  key: string;
  group: string;
  label: string;
  hint: string;
  type: string;
  /** "switch" for an on/off enum */
  control: "switch" | null;
  values: string[] | null;
  min: number | null;
  max: number | null;
  unit: string | null;
  options: string[] | null;
  format: "email" | "contacts" | "links" | "retention" | null;
  maxLength: number | null;
  fields: { id: string; label: string; default: number; min: number; max: number; unit: string }[] | null;
  default: string | null;
  value: string | null;
  source: "env" | "site" | "default";
  /** The value saved here, kept while the environment overrides it. */
  stored: { value: string; at: number; by: string } | null;
}
export interface SiteSettings {
  groups: { id: string; title: string }[];
  settings: SiteSettingView[];
}
export function getSiteSettings(): Promise<SiteSettings> {
  return call(`/api/admin/settings`);
}
export async function saveSiteSetting(key: string, value: string): Promise<SiteSettingView> {
  return (
    await call<{ setting: SiteSettingView }>(`/api/admin/settings/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    })
  ).setting;
}
export async function resetSiteSetting(key: string): Promise<SiteSettingView> {
  return (
    await call<{ setting: SiteSettingView }>(`/api/admin/settings/${encodeURIComponent(key)}`, { method: "DELETE" })
  ).setting;
}
// ---- tool registries (the gateway's toolregistries.ts) ----
/** A configured tool registry as the Tools app gets it: `proxied` when its files come through this instance. */
export type EffectiveToolRegistry = ToolRegistryEntry & { proxied: boolean };
export interface ToolRegistryList {
  registries: EffectiveToolRegistry[];
  players: { allowed: boolean; signedIn: boolean; stored: number };
  proxy: boolean;
}
export function listToolRegistries(): Promise<ToolRegistryList> {
  return call(`/api/tools/registries`);
}
/** The instance's registries, with disabled ones (sysop). `source` is "env" while TOOL_REGISTRIES sets them. */
export interface AdminToolRegistries {
  source: "env" | "site";
  registries: ToolRegistryEntry[];
  envError?: string;
  max: number;
  proxy: boolean;
  playersAllowed: boolean;
}
export function adminToolRegistries(): Promise<AdminToolRegistries> {
  return call(`/api/admin/tool-registries`);
}
export function myToolRegistries(): Promise<{ allowed: boolean; registries: ToolRegistryEntry[]; max: number }> {
  return call(`/api/my/tool-registries`);
}
/** Where a list of registries is changed: the instance's (sysop) or the player's own. */
export type RegistryListScope = "admin" | "my";
const registriesPath = (scope: RegistryListScope) =>
  scope === "admin" ? `/api/admin/tool-registries` : `/api/my/tool-registries`;
export async function addToolRegistry(
  scope: RegistryListScope,
  r: { spec: string; authority: string; label?: string },
): Promise<ToolRegistryEntry> {
  return (
    await call<{ registry: ToolRegistryEntry }>(registriesPath(scope), { method: "POST", body: JSON.stringify(r) })
  ).registry;
}
export async function updateToolRegistry(
  scope: RegistryListScope,
  id: string,
  patch: { enabled?: boolean; label?: string },
): Promise<ToolRegistryEntry> {
  return (
    await call<{ registry: ToolRegistryEntry }>(`${registriesPath(scope)}/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    })
  ).registry;
}
export async function confirmToolRegistryKey(
  scope: RegistryListScope,
  id: string,
  authority: string,
): Promise<ToolRegistryEntry> {
  return (
    await call<{ registry: ToolRegistryEntry }>(`${registriesPath(scope)}/${encodeURIComponent(id)}/confirm`, {
      method: "POST",
      body: JSON.stringify({ authority }),
    })
  ).registry;
}
export function removeToolRegistry(scope: RegistryListScope, id: string): Promise<{ removed: boolean }> {
  return call(`${registriesPath(scope)}/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** One line of the callsign-identity self-check; `fix` is set on every warn and fail. */
export interface Net44CheckLine {
  id: "endpoint" | "a" | "txt" | "callsign" | "target" | "operator" | "dnssec" | "aaaa";
  status: "pass" | "warn" | "fail" | "info";
  label: string;
  detail: string;
  fix?: string;
}
/** One DNS record to publish, named as the 44Net Portal takes it (`portal`: the part left of `<call>.ampr.org`). */
export interface PortalRecord {
  name: string;
  portal: string;
  type: "A" | "TXT";
  value: string;
  /** The value is a placeholder to fill in (the 44.x address). */
  placeholder: boolean;
  purpose: string;
}
/** The records this instance publishes so peers add it by callsign, and, when checked, what DNS answers. */
export interface CallsignIdentity {
  applicable: boolean;
  callsign: string | null;
  host: string | null;
  web: string | null;
  records: PortalRecord[];
  alternative: PortalRecord | null;
  reason?: string;
  lines?: Net44CheckLine[];
}
/** The callsign-identity records; with `check`, the read-only self-check of what peers find in DNS. */
export function getCallsignIdentity(check = false): Promise<CallsignIdentity> {
  return call(`/api/admin/federation/identity${check ? "?check=1" : ""}`);
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
// ---- stages offline: the published start and the NFC stages a pack carries sealed (stageseal.ts) ----
const STAGE_UNLOCKS_KEY = "acs.stages.unlocked";
type LocalUnlocks = Record<string, StagePayload>;
async function localUnlocks(): Promise<LocalUnlocks> {
  try {
    return JSON.parse((await (await offlineReady()).kvGet(STAGE_UNLOCKS_KEY)) ?? "{}") as LocalUnlocks;
  } catch {
    return {};
  }
}

/**
 * A cache's stages; without a connection, as its offline pack knows them: the published start, every stage
 * this phone unlocked offline, and the rest locked (an NFC stage the pack carries sealed can be unlocked by
 * scanning its tag).
 */
export async function getStages(
  cacheId: number,
  callsign?: string,
): Promise<{ stages: (CacheStage & { offline?: boolean })[] }> {
  try {
    return await call(`/api/caches/${cacheId}/stages${callsign ? `?callsign=${encodeURIComponent(callsign)}` : ""}`);
  } catch (e) {
    if (!isOffline(e)) throw e;
    const hit = await packCache(await offlineReady(), cacheId);
    if (!hit) throw e;
    const unlocks = await localUnlocks();
    return {
      stages: hit.cache.stages.map((s) => {
        const known = s.open ?? unlocks[`${cacheId}:${s.stageNo}`];
        return {
          stageNo: s.stageNo,
          unlock: s.unlock as CacheStage["unlock"],
          clue: known?.clue ?? null,
          mediaUrl: known?.mediaUrl ?? null,
          radiusM: 60,
          unlocked: !!known,
          lat: known?.lat ?? null,
          lon: known?.lon ?? null,
          // can this stage be unlocked here, without a connection?
          offline: !!s.sealed,
        };
      }),
    };
  }
}

/**
 * Unlock a stage. Without a connection, an NFC stage the pack carries sealed opens with its tag code on the
 * phone; the unlock is kept here and queued, and the instance confirms it on sync (log/logQueue.ts). Any
 * other stage answers `needs_connection`.
 */
export async function unlockStage(
  cacheId: number,
  stageNo: number,
  callsign: string,
  appGeo?: AppGeo,
  code?: string,
): Promise<{ unlocked: boolean; lat?: number; lon?: number; reason?: string; distanceM?: number; offline?: boolean }> {
  try {
    return await call(`/api/caches/${cacheId}/stages/${stageNo}/unlock`, {
      method: "POST",
      body: JSON.stringify({ callsign, appGeo, code }),
    });
  } catch (e) {
    // a refusal with a reason is an answer, not a failure: the caller words it for the finder
    const refusal = stageRefusal(e);
    if (refusal) return { ...refusal, unlocked: false };
    if (!isOffline(e)) throw e;
    const store = await offlineReady();
    const hit = await packCache(store, cacheId);
    const stage = hit?.cache.stages.find((s) => s.stageNo === stageNo);
    if (!hit || !stage) throw e;
    if (stage.unlock !== "nfc" || !stage.sealed) return { unlocked: false, reason: "needs_connection" };
    if (!code?.trim()) return { unlocked: false, reason: "no_code" };
    const payload = await openSealedStage(code, stage.sealed);
    if (!payload) return { unlocked: false, reason: "bad_code" };
    const unlocks = await localUnlocks();
    unlocks[`${cacheId}:${stageNo}`] = payload;
    await store.kvSet(STAGE_UNLOCKS_KEY, JSON.stringify(unlocks));
    const instance = await getInstance();
    await enqueue(
      queueStore,
      {
        cacheId,
        kind: "unlock",
        stageNo,
        body: { loggerCall: callsign, logType: "unlock", code: code.trim() },
        label: hit.cache.code,
        ...(instance && { instance }),
      },
      Date.now(),
    );
    queueChanged();
    void askForBackgroundSync(instance);
    return { unlocked: true, lat: payload.lat ?? undefined, lon: payload.lon ?? undefined, offline: true };
  }
}
/** The body of a refused unlock that names why (`reason`), or null for any other error. */
function stageRefusal(e: unknown): { reason: string; distanceM?: number } | null {
  if (!(e instanceof ApiError) || e.status >= 500) return null;
  const d = e.data as { reason?: unknown; distanceM?: unknown } | null;
  return typeof d?.reason === "string"
    ? { reason: d.reason, ...(typeof d.distanceM === "number" && { distanceM: d.distanceM }) }
    : null;
}
/** Set the stage list. `prevStageNo` is the number a stage had when the list was loaded, so its clip follows it. */
export function setStages(
  cacheId: number,
  ownerCall: string,
  stages: Array<Partial<CacheStage> & { stageNo: number; prevStageNo?: number; secret?: string }>,
): Promise<{ ok: boolean; offline: { stageNo: number; offline: boolean; reason?: string }[] }> {
  return call(`/api/caches/${cacheId}/stages`, { method: "POST", body: JSON.stringify({ ownerCall, stages }) });
}
/** Upload an audio stage's clip (at most `MEDIA_LIMITS.audio`), as the cache's owner. It replaces the stage's clip. */
export function uploadStageClip(
  cacheId: number,
  stageNo: number,
  ownerCall: string,
  file: File,
): Promise<{ ok: true }> {
  return call(`/api/caches/${cacheId}/stages/${stageNo}/media`, {
    method: "PUT",
    headers: { "content-type": file.type || "audio/mpeg", "x-owner-call": ownerCall },
    body: file,
  });
}
/**
 * A stage clip that only its unlocker and the owner may hear, as a local object URL. The app fetches it with the
 * sign-in cookie, which an `<audio>` element does not send to an API on another origin. The caller revokes it.
 */
export async function privateClipUrl(path: string): Promise<string> {
  if (path.startsWith("blob:")) return path;
  const res = await reach(API_BASE + path, { credentials: "include" });
  if (!res.ok)
    throw new ApiError(res.status === 404 ? "This clip is not available" : `${res.status}`, res.status, null);
  return URL.createObjectURL(await res.blob());
}
/** Absolute URL for a media clue path returned by the API. */
/** A media path on the instance as a URL; a local object URL (an offline pack's image) as it is. */
export const mediaUrl = (path: string): string => (path.startsWith("blob:") ? path : API_BASE + path);

// ---- cache media gallery: owner-managed photos/audio/files on a cache ----
export interface CacheMediaItem {
  id: number;
  kind: "image" | "audio" | "file";
  contentType: string;
  title: string | null;
  url: string;
  bytes: number;
  createdAt?: number;
  /** The small copy stored beside an image, for galleries. */
  thumbUrl?: string;
  thumbBytes?: number;
}
/** A cache's media; without a connection, the images its offline pack keeps, as local object URLs the caller revokes. */
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
/**
 * Upload a cache's media. A photo is scaled down here first (at most PHOTO_PX on its longest side), and
 * its thumbnail is stored beside it, so galleries and offline packs load a few kilobytes instead of the
 * photo; a photo whose thumbnail could not be made or stored still uploads, without one.
 */
export async function addCacheMedia(cacheId: number, file: File, title?: string): Promise<{ item: CacheMediaItem }> {
  const isImage = file.type.startsWith("image/");
  const photo = (isImage && (await resizeImage(file, PHOTO_PX, 0.85))) || file;
  const problem = mediaUploadProblem(photo.type || file.type, photo.size);
  if (problem) throw new Error(problem);
  const q = title ? `?title=${encodeURIComponent(title)}` : "";
  const res = await reach(`${API_BASE}/api/caches/${cacheId}/media${q}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": photo.type || "application/octet-stream" },
    body: photo,
  });
  const body = (await res.json().catch(() => ({}))) as { item?: CacheMediaItem; error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  const item = body.item!;
  const thumb = isImage ? await thumbnailOf(photo) : null;
  if (thumb) {
    const t = await reach(`${API_BASE}/api/caches/${cacheId}/media/${item.id}/thumb`, {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": thumb.type },
      body: thumb,
    }).catch(() => null);
    if (t?.ok) Object.assign(item, (await t.json()) as { thumbUrl: string; thumbBytes: number });
  }
  return { item };
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
  /** Carries federation over FBB to and from this partner (the instance's FED_BBS must be on too). */
  federation: boolean;
}
/** The partners, and whether federation over FBB (FED_BBS) is on for this instance. */
export function listForwardPartners(): Promise<{ partners: ForwardPartner[]; federationOverFbb: boolean }> {
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
/** Personal mail you SENT, with its F6FBB state: read, or forwarded to partner BBSes. */
export function getBbsSent(callsign: string): Promise<{ messages: BbsMessage[] }> {
  return call(`/api/bbs/sent?from=${encodeURIComponent(callsign)}`);
}
/** Mark a personal message read (clears its unread state). */
export function markBbsRead(id: number): Promise<{ ok: boolean }> {
  return call(`/api/bbs/messages/${id}/read`, { method: "POST" });
}

// ---- account data lifecycle (GDPR) ----
type SignedAction = { key: string; sig: string; at: number };
/**
 * Export the account's data: authorised by the signed-in session, or by a device-key signature without one.
 * `me` names the account of a data-only session, which holds no callsign to name.
 */
export function exportAccount(callsign: string, auth?: SignedAction): Promise<Record<string, unknown>> {
  return call(`/api/account/${encodeURIComponent(callsign)}/export`, {
    method: "POST",
    body: JSON.stringify(auth ?? {}),
  });
}
/** Erase the account: authorised by the signed-in session, or by a device-key signature without one. */
export function deleteAccount(callsign: string, auth?: SignedAction): Promise<{ ok: boolean; erased: string }> {
  return call(`/api/account/${encodeURIComponent(callsign)}/delete`, {
    method: "POST",
    body: JSON.stringify(auth ?? {}),
  });
}

/** The owner's edit of a cache: only the fields given change; `minTrust: null` returns it to the instance's minimum. */
export function updateCache(id: number, body: UpdateCacheRequest): Promise<{ cache: CacheSummary }> {
  return call(`/api/caches/${id}`, { method: "PATCH", body: JSON.stringify(body) });
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
export type LogBody = {
  loggerCall: string;
  logType: LogType;
  comment?: string;
  appGeo?: AppGeo;
  author?: AuthorSig;
  /** the finder flags the cache for its owner (a found or did-not-find log) */
  needsMaintenance?: boolean;
};
/** What the offline queue holds: a log, or a stage unlocked offline (with the code that opened it). */
export type QueueBody = Omit<LogBody, "logType"> & { logType: LogType | "unlock"; code?: string };

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
      const instance = await getInstance();
      await enqueue(queueStore, { cacheId, body, ...(label && { label }), ...(instance && { instance }) }, Date.now());
      queueChanged();
      void askForBackgroundSync(instance);
      return { logged: true, queued: true, logType: body.logType, accountVerified: false, verified: false };
    },
  );
}

export const queuedLogs = (): Promise<QueuedLog<QueueBody>[]> => loadQueue<QueueBody>(queueStore);
export const attentionLogs = (): Promise<AttentionLog<QueueBody>[]> => loadAttention<QueueBody>(queueStore);

/**
 * Send the queued logs that are due (the signature and its time are kept, so the instance verifies each
 * at the time it was made). A refused log moves to needs-attention, never away.
 */
export function flushLogQueue(): Promise<FlushResult> {
  // one flush at a time across this page and the service worker's background sync
  return withQueueLock(flushUnlocked);
}
async function flushUnlocked(): Promise<FlushResult> {
  if (!(await queuedLogs()).length) return { sent: 0, refused: 0 };
  const instance = (await getInstance()) || undefined;
  const res = await flush<QueueBody>(
    queueStore,
    async (it) => {
      try {
        if (it.kind === "unlock")
          // a stage unlocked offline from a pack: the instance checks the code and records it
          await call(`/api/caches/${it.cacheId}/stages/${it.stageNo}/unlock`, {
            method: "POST",
            body: JSON.stringify({ callsign: it.body.loggerCall, code: it.body.code }),
          });
        else
          await call(`/api/caches/${it.cacheId}/logs`, {
            method: "POST",
            body: JSON.stringify({ ...it.body, offline: true }),
          });
      } catch (e) {
        if (isOffline(e)) throw { kind: "offline" } satisfies SendFailure;
        const status = e instanceof ApiError ? e.status : 0;
        if (status === 0 || status >= 500 || status === 408 || status === 429)
          throw { kind: "retry" } satisfies SendFailure;
        const refusal = it.kind === "unlock" ? stageRefusal(e) : null;
        throw {
          kind: "refused",
          status,
          reason: refusal
            ? stageRefusalText(refusal.reason, refusal.distanceM != null ? `${refusal.distanceM} m` : undefined)
            : (e as Error).message,
        } satisfies SendFailure;
      }
    },
    Date.now(),
    instance,
  );
  if (res.sent || res.refused) queueChanged();
  return res;
}

/** The lock the page and the service worker take around a flush, so a log is never sent twice at once. */
const QUEUE_LOCK = "acs-logqueue";
function withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  return locks ? locks.request(QUEUE_LOCK, fn) : fn();
}

/**
 * Ask the browser to sync the queue in the background once the connection returns, even with the app
 * closed (Background Sync: Chromium; elsewhere the queue syncs when the app is opened). The worker reads the
 * queue from IndexedDB, and where to send it from the two values stored here.
 */
async function askForBackgroundSync(instance: string): Promise<void> {
  try {
    const st = await offlineReady();
    await st.kvSet("acs.sync.apiBase", API_BASE || location.origin);
    if (instance) await st.kvSet("acs.sync.instance", instance);
    const reg = (await navigator.serviceWorker?.getRegistration()) as
      (ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }) | undefined;
    await reg?.sync?.register("acs-logqueue");
  } catch {
    /* no Background Sync here: the queue syncs when the app is opened or the connection returns */
  }
}

/** Queue a refused log again (optionally with a new comment) and try it at once. */
export async function retryAttentionLog(index: number, comment?: string): Promise<FlushResult> {
  await retryAttention(queueStore, index, Date.now(), comment);
  queueChanged();
  return flushLogQueue();
}
/** Remove a waiting log the user sent another way (by radio). */
export async function removeQueuedLog(cacheId: number, queuedAt: number): Promise<void> {
  await removeQueued(queueStore, cacheId, queuedAt);
  queueChanged();
}

/** The instance's service call, as the last pack downloaded named it (for logging from a radio offline). */
export async function knownServiceCall(): Promise<string | null> {
  return (await offlineReady()).kvGet("acs.serviceCall");
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
export function startAprsVerify(callsign: string, claim?: string): Promise<VerifyChallenge> {
  return call(`/verify/aprs/start`, { method: "POST", body: JSON.stringify({ callsign, claim }) });
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

/** An ampr.org DNS challenge: publish `record` (name, TXT, value) at `_aprscaching-verify.<call>.ampr.org`. */
export interface AmprChallenge {
  code: string;
  name: string;
  value: string;
  record: string;
  expiresAt: number;
}
export function startAmprVerify(callsign: string, claim?: string): Promise<AmprChallenge> {
  return call(`/verify/ampr/start`, { method: "POST", body: JSON.stringify({ callsign, claim }) });
}
/** Look the published record up; rejects with the server's reason when it does not verify. */
export function checkAmprVerify(callsign: string, claim?: string): Promise<{ verified: boolean; method: string }> {
  return call(`/verify/ampr/check`, { method: "POST", body: JSON.stringify({ callsign, claim }) });
}

/** A LoTW challenge: the exact `message` to sign with the callsign certificate's key. */
export interface LotwChallenge {
  challenge: string;
  message: string;
  expiresAt: number;
}
export function startLotwVerify(callsign: string, claim?: string): Promise<LotwChallenge> {
  return call(`/verify/lotw/start`, { method: "POST", body: JSON.stringify({ callsign, claim }) });
}
export function completeLotwVerify(
  callsign: string,
  proof: { certificates: string[]; signature: string },
  claim?: string,
): Promise<{ verified: boolean; method: string }> {
  return call(`/verify/lotw/complete`, { method: "POST", body: JSON.stringify({ callsign, ...proof, claim }) });
}

/**
 * A claim on a call an account holds without having proven control of it: the licensee proves control with
 * any verification method, passing the claim token in place of a session, and the call moves to them.
 */
export interface CallClaim {
  /** The bearer token the verification methods take as `claim`; given once. */
  claim: string;
  callsign: string;
  /** An account holds the call now (false: an operator call nobody holds yet). */
  held: boolean;
  expiresAt: number;
}
export function startClaim(callsign: string): Promise<CallClaim> {
  return call(`/auth/claims`, { method: "POST", body: JSON.stringify({ callsign }) });
}
/** Where a claim stands; the first answer that finds a sign-up claim done signs the claimant in. */
export function claimStatus(claim: string): Promise<{
  status: "open" | "done" | "refused" | "expired";
  callsign: string;
  method: string | null;
  signedIn?: boolean;
}> {
  return call(`/auth/claims/status`, { method: "POST", body: JSON.stringify({ claim }) });
}

// ---- auth: session, passkey ceremonies, email magic-link ----
export type Session = {
  callsign: string | null;
  verified?: boolean;
  email?: string | null;
  /** An address given at registration, waiting for its owner to open the confirmation link. */
  pendingEmail?: string | null;
  /** The session opens only the data of an account that holds no callsign: its export and its erasure. */
  accountData?: boolean;
  /** How many passkeys the account has: with none and no confirmed email, the session is its only way in. */
  passkeys?: number;
  /** Signed out: why the session this browser held ended, when the person is to be told. */
  ended?: SessionEnded;
};
/** Why a session ended: the account was suspended, or its callsign moved to its licensee or was released. */
export type SessionEnded =
  | { reason: "suspended"; until: number | null; why: string }
  | { reason: "released"; callsign: string; by: "licensee" | "sysop"; note: string | null; callless: boolean };
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
export function claim(callsign: string): Promise<{
  callsign: string;
  exists: boolean;
  hasPasskey: boolean;
  /** An account that has not proven control holds the call: its licensee can take it over by proof. */
  claimable?: boolean;
  /** The instance operator's call, which nobody holds yet: only a proof of control or the operator's link opens it. */
  operatorCall?: boolean;
  licence?: Licence;
}> {
  return call(`/auth/claim`, { method: "POST", body: JSON.stringify({ callsign }) });
}
export function emailStart(
  email: string,
  callsign?: string,
): Promise<{ sent: boolean; purpose: string; devLink?: string }> {
  return call(`/auth/email/start`, { method: "POST", body: JSON.stringify({ email, callsign }) });
}
/** Email a link that opens the data of an account holding no callsign, to export or erase it. */
export function accountDataStart(email: string): Promise<{ sent: boolean; purpose: string; devLink?: string }> {
  return call(`/auth/email/start`, { method: "POST", body: JSON.stringify({ email, purpose: "account-data" }) });
}
/** The answer to an address change or a resend: the address waiting for confirmation, or the confirmed one
 *  when it was given again. `devLink` comes back only on an instance without mail that opts into dev tokens. */
export type EmailConfirmation = {
  ok: boolean;
  email?: string;
  pendingEmail: string | null;
  sent?: boolean;
  devLink?: string;
};
/** Give the signed-in account a new sign-in and recovery address (or its first); it waits for confirmation. */
export function changeEmail(email: string): Promise<EmailConfirmation> {
  return call(`/auth/email/change`, { method: "POST", body: JSON.stringify({ email }) });
}
/** Mail the confirmation link for the address the account is waiting on again. */
export function resendEmailConfirmation(): Promise<EmailConfirmation> {
  return call(`/auth/email/resend`, { method: "POST", body: "{}" });
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

/** One of the signed-in account's passkeys: when it was added and how its device connects (WebAuthn transports). */
export interface Passkey {
  id: string;
  createdAt: number;
  transports: string[];
}
/** The account's passkeys, its primary call, and whether it has a confirmed email or one waiting for confirmation. */
export function listPasskeys(): Promise<{
  callsign: string;
  hasEmail: boolean;
  emailPending?: boolean;
  passkeys: Passkey[];
}> {
  return call(`/auth/passkeys`);
}
/** Remove one passkey, such as a lost device's. The last one of an account without an email stays. */
export function removePasskey(id: string): Promise<{ ok: boolean; remaining: number }> {
  return call(`/auth/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" });
}
export async function registerPasskey(
  callsign: string,
  email?: string,
): Promise<{ ok: boolean; callsign: string; emailPending?: boolean; sent?: boolean; devLink?: string }> {
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
/** Where to report a bug: a GitHub repository's new-issue chooser, or any other forge's repository page. */
export function bugReportUrl(repo: string): string {
  const r = repo.replace(/\.git$/, "").replace(/\/$/, "");
  return /^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(r) ? `${r}/issues/new/choose` : r;
}
