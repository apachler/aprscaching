import type {
  CacheSummary, CacheDetail, CacheLogEntry, CreateCacheRequest, UpdateCacheRequest,
  MapCache, LogType, AppGeo, TrustTier, LeaderboardEntry, Profile,
  StationSummary, StationDetail, DecodedPacket, PortStat, MessageItem, Spot,
} from "@aprsweb/shared";

export type { CacheSummary, CacheDetail, CacheLogEntry, CreateCacheRequest, MapCache, LogType, AppGeo, TrustTier, LeaderboardEntry, Profile, StationSummary, StationDetail, DecodedPacket, PortStat, MessageItem, Spot };

/** Worker base URL. In dev the Worker runs on :8787; in prod set VITE_API_BASE to api.aprscaching.com. */
export const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? "http://127.0.0.1:8787";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_BASE + path, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

export type BBox = [minLon: number, minLat: number, maxLon: number, maxLat: number];

export function listCaches(bbox: BBox, includeUnvetted = false): Promise<{ caches: MapCache[] }> {
  return call(`/api/caches?bbox=${bbox.join(",")}${includeUnvetted ? "&includeUnvetted=1" : ""}`);
}

export function getCache(id: number, callsign?: string): Promise<{ cache: CacheDetail }> {
  return call(`/api/caches/${id}${callsign ? `?callsign=${encodeURIComponent(callsign)}` : ""}`);
}

export function getLeaderboard(bbox: BBox, metric: "finds" | "points"): Promise<{ leaderboard: LeaderboardEntry[] }> {
  return call(`/api/leaderboard?metric=${metric}&bbox=${bbox.join(",")}`);
}
import type { Corroborator } from "@aprsweb/shared";
export type { Corroborator };
/** Top IGates by Tier-A finds they helped verify — running infrastructure as a visible contribution. */
export function getCorroborators(bbox?: BBox, period = "all"): Promise<{ period: string; corroborators: Corroborator[] }> {
  const q = new URLSearchParams({ period }); if (bbox) q.set("bbox", bbox.join(","));
  return call(`/api/corroborators?${q.toString()}`);
}
export interface ProfileEdit { displayName?: string; homeGrid?: string; avatarUrl?: string; bio?: string; links?: { label: string; url: string }[]; publicContact?: string; profilePublic?: boolean }
export function updateProfile(p: ProfileEdit): Promise<{ ok: boolean }> {
  return call(`/auth/profile`, { method: "POST", body: JSON.stringify(p) });
}
export function getProfile(callsign: string): Promise<Profile> {
  return call(`/api/profile/${encodeURIComponent(callsign)}`);
}
import type { SearchResults } from "@aprsweb/shared";
export type { SearchResults, SearchHitCache, SearchHitStation } from "@aprsweb/shared";
/** Enriched as-you-type suggestions across caches + stations (docs/11 M2). */
export function searchSuggest(q: string, signal?: AbortSignal, limit = 8): Promise<SearchResults> {
  return call(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`, { signal });
}
import type { ActivityItem, PageInfo } from "@aprsweb/shared";
export type { ActivityItem };
/** Keyset-paginated recent finds (docs/11). Pass nextCursor back as `cursor` for older pages. */
export function getActivity(bbox?: BBox, cursor?: string | null, limit = 30): Promise<{ activity: ActivityItem[] } & PageInfo> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (bbox) q.set("bbox", bbox.join(","));
  if (cursor) q.set("cursor", cursor);
  return call(`/api/activity?${q.toString()}`);
}
/** Paginated logbook for a cache (older entries past the embedded first page). */
export function getCacheLogs(id: number, cursor?: string | null, limit = 50): Promise<{ logs: CacheLogEntry[] } & PageInfo> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (cursor) q.set("cursor", cursor);
  return call(`/api/caches/${id}/logs?${q.toString()}`);
}
export function toggleFavorite(cacheId: number, callsign: string, on: boolean): Promise<{ on: boolean; count: number }> {
  return call(`/api/caches/${cacheId}/favorite`, { method: "POST", body: JSON.stringify({ callsign, on }) });
}

// ---- live activity spots (docs/20 S2) — read-only overlay, opt-in ----
export function getSpots(bbox: BBox, opts: { bands?: string[]; modes?: string[]; sources?: string[] } = {}):
  Promise<{ enabled: boolean; count: number; fetchedAt: number | null; spots: Spot[] }> {
  const q = new URLSearchParams({ bbox: bbox.join(",") });
  if (opts.bands?.length) q.set("bands", opts.bands.join(","));
  if (opts.modes?.length) q.set("modes", opts.modes.join(","));
  if (opts.sources?.length) q.set("sources", opts.sources.join(","));
  return call(`/api/spots?${q.toString()}`);
}

// ---- M5 workbench: live stations + packet inspector ----
export function getStations(bbox: BBox): Promise<{ stations: StationSummary[] }> {
  return call(`/api/stations?bbox=${bbox.join(",")}`);
}
export function getStation(callsign: string): Promise<{ station: StationDetail }> {
  return call(`/api/stations/${encodeURIComponent(callsign)}`);
}
import type { StationTrackPoint } from "@aprsweb/shared";
export type { StationTrackPoint };
export interface StationTrack { callsign: string; from: number; until: number; count: number; positions: StationTrackPoint[] }
/** Date-windowed position history (docs/11 M3) via the public read API — free, rate-limited. */
export function getStationTrack(callsign: string, fromSec: number, toSec: number, signal?: AbortSignal): Promise<StationTrack> {
  return call(`/api/v1/station/${encodeURIComponent(callsign)}/track?from=${Math.floor(fromSec)}&to=${Math.floor(toSec)}`, { signal });
}
export function decodePacket(raw: string): Promise<DecodedPacket> {
  return call(`/api/decode`, { method: "POST", body: JSON.stringify({ raw }) });
}
export function getPorts(): Promise<{ window: string; ports: PortStat[] }> {
  return call(`/api/ports`);
}
export function getMessages(bulletins = false, cursor?: string | null, limit = 30): Promise<{ messages: MessageItem[] } & PageInfo> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (bulletins) q.set("bulletins", "1");
  if (cursor) q.set("cursor", cursor);
  return call(`/api/messages?${q.toString()}`);
}

// ---- remote control of your own ingest box (docs/20 R2) ----
export interface BoxCommand {
  id: number; callsign?: string; kind: string; payload?: unknown;
  status: "queued" | "sent" | "done" | "failed"; result?: string;
  createdAt: number; sentAt?: number | null; ackedAt?: number | null;
}
export function enqueueBoxCommand(boxId: string, cmd: { kind: string; payload?: unknown; callsign?: string }):
  Promise<{ id: number; boxId: string; kind: string; callsign: string; status: string; tx: boolean }> {
  return call(`/api/box/${encodeURIComponent(boxId)}/command`, { method: "POST", body: JSON.stringify(cmd) });
}
export function getBoxLog(boxId: string): Promise<{ boxId: string; commands: BoxCommand[] }> {
  return call(`/api/box/${encodeURIComponent(boxId)}/log`);
}

// ---- watchlist + alerts (docs/20 W1) ----
export interface WatchEntry { callsign: string; addedAt: number; }
export interface WatchAlert { id: number; callsign: string; kind: "heard" | "near_cache" | "cache_found" | "corroborated"; detail?: string; cacheId?: number | null; lat?: number | null; lon?: number | null; ts: number; seen: boolean; }
export function listWatch(): Promise<{ watching: WatchEntry[]; unseen: number }> { return call(`/api/watch`); }
export function addWatch(callsign: string): Promise<{ ok: boolean; callsign: string }> { return call(`/api/watch`, { method: "POST", body: JSON.stringify({ callsign }) }); }
export function removeWatch(callsign: string): Promise<{ ok: boolean }> { return call(`/api/watch/${encodeURIComponent(callsign)}`, { method: "DELETE" }); }
export function getWatchAlerts(cursor?: string | null, limit = 50): Promise<{ alerts: WatchAlert[] } & PageInfo> {
  const q = new URLSearchParams({ limit: String(limit) }); if (cursor) q.set("cursor", cursor);
  return call(`/api/watch/alerts?${q.toString()}`);
}
export function markWatchSeen(): Promise<{ ok: boolean }> { return call(`/api/watch/seen`, { method: "POST" }); }

// ---- save / share map views (docs/11 M1) ----
export interface MapViewState {
  center?: [number, number]; zoom?: number;
  layers?: { spots?: boolean; stations?: boolean };
  filters?: { types: string[]; q: string };
  spotFilters?: { bands: string[]; modes: string[]; sources: string[] };
  selected?: number | null;
}
export function saveView(state: MapViewState, name?: string): Promise<{ slug: string; public: boolean }> {
  return call(`/api/views`, { method: "POST", body: JSON.stringify({ state, name }) });
}
export function resolveView(slug: string): Promise<{ slug: string; name: string | null; ownerCall: string; createdAt: number; state: MapViewState }> {
  return call(`/v/${encodeURIComponent(slug)}`);
}

// ---- notification prefs + push subscription (ADR-4b) ----
export function getNotifyPrefs(): Promise<{ digest: boolean; hasEmail: boolean; pushConfigured: boolean }> { return call(`/api/notify/prefs`); }
export function setNotifyPrefs(digest: boolean): Promise<{ digest: boolean }> { return call(`/api/notify/prefs`, { method: "POST", body: JSON.stringify({ digest }) }); }
export function getPushKey(): Promise<{ key: string | null }> { return call(`/api/push/key`); }
export function subscribePush(sub: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }): Promise<{ ok: boolean }> {
  return call(`/api/push/subscribe`, { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys, topics: ["watch"] }) });
}
export function unsubscribePush(endpoint: string): Promise<{ ok: boolean }> {
  return call(`/api/push/unsubscribe`, { method: "POST", body: JSON.stringify({ endpoint }) });
}
// ---- weather user-origination: a personal weather station (docs/17 W1) ----
export interface WxKeyInfo {
  callsign: string; station: string; key: string | null; lastSeen: number | null;
  ecowittPath: string | null; wuUrl: string | null;
}
/** Read the caller's PWS push key + ready-to-paste station URLs (null key until issued). */
export function getWxKey(): Promise<WxKeyInfo> { return call(`/api/wx/key`); }
/** (Re)issue the PWS push key — invalidates any previous one. */
export function issueWxKey(): Promise<WxKeyInfo> { return call(`/api/wx/key`, { method: "POST" }); }

// ---- operated-stations registry: manage your own stations (docs/13 M5) ----
import type { OperatedStation, StationRole, StationWxKey } from "@aprsweb/shared";
export type { OperatedStation, StationRole, StationWxKey };
export interface StationInput { callsign?: string; lat?: number | null; lon?: number | null; symbol?: string | null; description?: string | null; roles?: StationRole[] }
export function listMyStations(cursor?: string | null, limit = 50): Promise<{ stations: OperatedStation[] } & PageInfo> {
  const q = new URLSearchParams({ limit: String(limit) }); if (cursor) q.set("cursor", cursor);
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
export function getStationWxKey(id: number): Promise<StationWxKey> { return call(`/api/my/stations/${id}/wx-key`); }
export function issueStationWxKey(id: number): Promise<StationWxKey> { return call(`/api/my/stations/${id}/wx-key`, { method: "POST" }); }
/** Turn an operated station into an APRScache at its location (single, or a beacon-following living cache). */
export function stationToCache(id: number, opts: { living?: boolean; title?: string } = {}): Promise<{ cache: CacheSummary }> {
  return call(`/api/my/stations/${id}/cache`, { method: "POST", body: JSON.stringify(opts) });
}
/** "Become a cache" — an aprs_living cache that follows your own beacon (placed at your beacon/home). */
export function becomeACache(opts: { title?: string } = {}): Promise<{ cache: CacheSummary }> {
  return call(`/api/me/cache`, { method: "POST", body: JSON.stringify(opts) });
}

// ---- supporter recognition + public ledger (docs/12 M4) — recognition only, gates nothing ----
export interface SupportLedger {
  currency: string; totalInCents: number; totalOutCents: number; balanceCents: number;
  buckets: Record<string, { inCents: number; outCents: number }>;
  months: { month: string; inCents: number; outCents: number }[];
}
export interface SupportInfo {
  model: string; donationLinks: { label: string; url: string }[];
  ledger: SupportLedger; supporters: string[]; supporterCount: number;
}
export interface SupportPrefs { supporter: boolean; hideNag: boolean }
export function getSupport(): Promise<SupportInfo> { return call(`/api/support`); }
export function getSupportPrefs(): Promise<SupportPrefs> { return call(`/api/support/prefs`); }
export function setSupportPrefs(hideNag: boolean): Promise<SupportPrefs> {
  return call(`/api/support/prefs`, { method: "POST", body: JSON.stringify({ hideNag }) });
}
/** The public transparency ledger page (server-rendered on the gateway). */
export const supportUrl = `${API_BASE}/support`;

// ---- browser-direct RF ingest (docs/16 H1) — forward Web Serial KISS frames to a gateway ----
import type { Packet } from "@aprsweb/shared";
export type { Packet };
/**
 * Forward decoded RF packets to a gateway's /ingest. Authenticated by the ingest secret, so this is
 * the operator-local / self-host path (the rule's blessed single-operator case): the operator points
 * it at their own gateway. `base` defaults to the configured API base.
 */
export async function ingestPackets(packets: Packet[], secret: string, base = API_BASE): Promise<{ ok: boolean; stored: number }> {
  const res = await fetch(`${base.replace(/\/+$/, "")}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ingest-secret": secret },
    body: JSON.stringify({ packets }),
  });
  if (!res.ok) throw new Error(`ingest ${res.status}`);
  return res.json() as Promise<{ ok: boolean; stored: number }>;
}

/**
 * Forward decoded RF to a PUBLIC gateway, authenticated by the operator's device-key signature
 * (docs/16 H1.5) — no shared secret. The key must be registered to `callsign` (registerKey).
 * Browser-heard frames are stored IGate-less and stay Tier C.
 */
export async function ingestSigned(packets: Packet[], callsign: string, base = API_BASE): Promise<{ ok: boolean; stored: number }> {
  const { signIngest } = await import("./crypto.js");
  const headers = await signIngest(callsign, packets);
  if (!headers) throw new Error("this browser can't sign (needs Ed25519)");
  const res = await fetch(`${base.replace(/\/+$/, "")}/ingest`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ packets }),
  });
  if (!res.ok) throw new Error(`ingest ${res.status}`);
  return res.json() as Promise<{ ok: boolean; stored: number }>;
}

/** Public CoT/TAK feed URL for the current viewport (paste into ATAK as a data feed). */
export function cotUrl(bbox: BBox): string {
  return `${API_BASE}/api/cot?bbox=${bbox.join(",")}`;
}

/** A federation peer with its T4.3 health metrics (operator observability). */
export interface FedPeer {
  url: string; instance: string | null; signed: number; trust: "trusted" | "unvetted" | "blocked";
  health: "ok" | "error" | "new" | "blocked"; errorRate: number;
  last_sync: number | null; last_ok: number | null; last_error: string | null;
  sync_ok: number; sync_err: number; mirrored_total: number;
  rep_confirmed: number; rep_failed: number;
  lastCounts: Record<string, number> | null;
}
export function listFederationPeers(): Promise<{ peers: FedPeer[] }> {
  return call(`/federation/peers`);
}

// ---- M2 audio-cache: staged multi-cache ----
import type { CacheStage } from "@aprsweb/shared";
export type { CacheStage };
export function getStages(cacheId: number, callsign?: string): Promise<{ stages: CacheStage[] }> {
  return call(`/api/caches/${cacheId}/stages${callsign ? `?callsign=${encodeURIComponent(callsign)}` : ""}`);
}
export function unlockStage(cacheId: number, stageNo: number, callsign: string, appGeo?: AppGeo): Promise<{ unlocked: boolean; lat?: number; lon?: number; reason?: string; distanceM?: number }> {
  return call(`/api/caches/${cacheId}/stages/${stageNo}/unlock`, { method: "POST", body: JSON.stringify({ callsign, appGeo }) });
}
export function setStages(cacheId: number, ownerCall: string, stages: Array<Partial<CacheStage> & { stageNo: number }>): Promise<{ ok: boolean }> {
  return call(`/api/caches/${cacheId}/stages`, { method: "POST", body: JSON.stringify({ ownerCall, stages }) });
}
/** Absolute URL for a media clue path returned by the API. */
export const mediaUrl = (path: string): string => API_BASE + path;

// ---- per-cache share funnel (docs/11 M4): print a QR on your station so visitors can find it ----
/** The public deep-link a QR encodes (opens the cache in the app — the current origin). */
export const cacheShareUrl = (code: string): string =>
  `${typeof window !== "undefined" ? window.location.origin : ""}/?cache=${encodeURIComponent(code)}`;
/** An SVG QR for the cache's share link, served by the gateway embed surface. */
export const cacheQrUrl = (code: string, size = 256): string => `${API_BASE}/embed/qr.svg?cache=${encodeURIComponent(code)}&size=${size}`;

// ---- BBS store-and-forward ----
import type { BbsMessage } from "@aprsweb/shared";
export type { BbsMessage };
export function getBbsInbox(callsign: string): Promise<{ messages: BbsMessage[] }> {
  return call(`/api/bbs/messages?to=${encodeURIComponent(callsign)}`);
}
export function getBulletins(): Promise<{ bulletins: BbsMessage[] }> {
  return call(`/api/bbs/bulletins`);
}
export function postBbsMessage(body: { fromCall: string; toCall: string; subject?: string; body: string }): Promise<{ ok: boolean; id: number; type: string }> {
  return call(`/api/bbs/messages`, { method: "POST", body: JSON.stringify(body) });
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

export function updateCache(id: number, body: UpdateCacheRequest): Promise<{ cache: CacheSummary }> {
  return call(`/api/caches/${id}`, { method: "PATCH", body: JSON.stringify(body) });
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
  corroboratedBy?: string | null;   // peer instance that granted Tier A (F3)
  signerKey?: string | null;        // device key that signed the find (F0)
  queued?: boolean;                 // saved offline, will sync when connectivity returns
}

export interface AuthorSig { authorKey: string; authorSig: string; signedAt: number }
type LogBody = { loggerCall: string; logType: LogType; comment?: string; appGeo?: AppGeo; author?: AuthorSig };

// ---- offline-tolerant logging: queue a find if the network is down, sync when back ----
const QKEY = "acs.logqueue";
interface Queued { cacheId: number; body: LogBody }
const loadQueue = (): Queued[] => { try { return JSON.parse(localStorage.getItem(QKEY) || "[]"); } catch { return []; } };
const saveQueue = (q: Queued[]) => { try { localStorage.setItem(QKEY, JSON.stringify(q)); } catch { /* ignore */ } };
const isOffline = (e: unknown) => !navigator.onLine || e instanceof TypeError; // fetch network errors throw TypeError

export function logFind(cacheId: number, body: LogBody): Promise<LogResult> {
  return call<LogResult>(`/api/caches/${cacheId}/logs`, { method: "POST", body: JSON.stringify(body) })
    .catch((e) => {
      if (!isOffline(e)) throw e;
      const q = loadQueue(); q.push({ cacheId, body }); saveQueue(q);
      try { window.dispatchEvent(new Event("acs-queued")); } catch { /* ssr */ }
      return { logged: true, queued: true, logType: body.logType, accountVerified: false, verified: false };
    });
}

export const queuedLogCount = (): number => loadQueue().length;
/** Retry queued finds (the original timestamp/signature is preserved). Returns how many synced. */
export async function flushLogQueue(): Promise<number> {
  const q = loadQueue(); if (!q.length) return 0;
  const keep: Queued[] = [];
  for (const it of q) {
    try { await call(`/api/caches/${it.cacheId}/logs`, { method: "POST", body: JSON.stringify(it.body) }); }
    catch (e) { if (isOffline(e)) keep.push(it); /* else drop a rejected log */ }
  }
  saveQueue(keep);
  return q.length - keep.length;
}

export function registerKey(body: { callsign: string; publicKey: string; label?: string }): Promise<{ ok: boolean }> {
  return call(`/keys/register`, { method: "POST", body: JSON.stringify(body) });
}

/** Callsign-control verification (the APRS message-challenge). Verify the BASE call (SSIDs inherit). */
export function startAprsVerify(callsign: string): Promise<{ sent: boolean }> {
  return call(`/verify/aprs/start`, { method: "POST", body: JSON.stringify({ callsign }) });
}
export function confirmAprsVerify(callsign: string, code: string): Promise<{ verified: boolean }> {
  return call(`/verify/aprs/confirm`, { method: "POST", body: JSON.stringify({ callsign, code }) });
}
export function getVerifyStatus(callsign: string): Promise<{ verified: boolean }> {
  return call(`/verify/aprs/status?callsign=${encodeURIComponent(callsign)}`);
}

// ---- auth (M9): session, passkey ceremonies, email magic-link ----
export type Session = { callsign: string | null; verified?: boolean; email?: string | null };
export function getSession(): Promise<Session> { return call(`/auth/session`); }
export function logout(): Promise<{ ok: boolean }> { return call(`/auth/logout`, { method: "POST" }); }
export function claim(callsign: string): Promise<{ callsign: string; exists: boolean; hasPasskey: boolean }> {
  return call(`/auth/claim`, { method: "POST", body: JSON.stringify({ callsign }) });
}
export function emailStart(email: string, callsign?: string): Promise<{ sent: boolean; purpose: string; devLink?: string }> {
  return call(`/auth/email/start`, { method: "POST", body: JSON.stringify({ email, callsign }) });
}
/** Switch the signed-in account's active callsign. Switching to a held call preserves its
 *  verification; switching to a new base call adds it (unverified). */
export function changeCallsign(callsign: string): Promise<{ ok: boolean; callsign: string; verified: boolean }> {
  return call(`/auth/callsign`, { method: "POST", body: JSON.stringify({ callsign }) });
}
export type HeldCallsign = { callsign: string; verified: boolean; isPrimary: boolean; active: boolean };
/** The base callsigns this account holds, with verification + which is active/primary. */
export function listCallsigns(): Promise<{ active: string; callsigns: HeldCallsign[] }> {
  return call(`/auth/callsigns`);
}
/** Add another base callsign to the account (held + unverified; does not switch the active call). */
export function addCallsign(callsign: string): Promise<{ ok: boolean; callsign: string; verified: boolean }> {
  return call(`/auth/callsigns`, { method: "POST", body: JSON.stringify({ callsign }) });
}

function b64uToBuf(s: string): ArrayBuffer {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer;
}
function bufToB64u(b: ArrayBuffer): string {
  const u = new Uint8Array(b); let s = ""; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** Is a platform passkey usable here? (WebAuthn present + secure context.) */
export function passkeySupported(): boolean { return typeof window !== "undefined" && !!window.PublicKeyCredential && window.isSecureContext; }

export async function registerPasskey(callsign: string, email?: string): Promise<{ ok: boolean; callsign: string }> {
  const o = await call<any>(`/auth/passkey/register/begin`, { method: "POST", body: JSON.stringify({ callsign, email }) });
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: b64uToBuf(o.challenge), rp: o.rp,
    user: { id: b64uToBuf(o.user.id), name: o.user.name, displayName: o.user.displayName },
    pubKeyCredParams: o.pubKeyCredParams, timeout: o.timeout, attestation: o.attestation,
    authenticatorSelection: o.authenticatorSelection,
    excludeCredentials: (o.excludeCredentials ?? []).map((c: any) => ({ type: c.type, id: b64uToBuf(c.id) })),
  } }) as PublicKeyCredential;
  const r = cred.response as AuthenticatorAttestationResponse;
  return call(`/auth/passkey/register/finish`, { method: "POST", body: JSON.stringify({ callsign, credential: {
    id: cred.id, response: { clientDataJSON: bufToB64u(r.clientDataJSON), attestationObject: bufToB64u(r.attestationObject), transports: r.getTransports?.() ?? [] } } }) });
}
export async function loginPasskey(callsign: string): Promise<{ ok: boolean; callsign: string }> {
  const o = await call<any>(`/auth/passkey/login/begin`, { method: "POST", body: JSON.stringify({ callsign }) });
  const cred = await navigator.credentials.get({ publicKey: {
    challenge: b64uToBuf(o.challenge), rpId: o.rpId, timeout: o.timeout, userVerification: o.userVerification,
    allowCredentials: (o.allowCredentials ?? []).map((c: any) => ({ type: c.type, id: b64uToBuf(c.id) })),
  } }) as PublicKeyCredential;
  const r = cred.response as AuthenticatorAssertionResponse;
  return call(`/auth/passkey/login/finish`, { method: "POST", body: JSON.stringify({ callsign, credential: {
    id: cred.id, response: { clientDataJSON: bufToB64u(r.clientDataJSON), authenticatorData: bufToB64u(r.authenticatorData), signature: bufToB64u(r.signature) } } }) });
}

let instanceCache: Promise<string> | null = null;
/** This instance's federation id (cached), used to build the canonical authorship message. */
export function getInstance(): Promise<string> {
  if (!instanceCache) instanceCache = call<{ instance: string }>(`/.well-known/aprscaching`).then((d) => d.instance).catch(() => "");
  return instanceCache;
}

/** AGPL §13 (ADR-3): the source the running instance reports, + the redirect link to it. */
export type SourceInfo = { repo: string; commit: string | null; tag: string | null; builtAt: number | null; license: string };
export function getSource(): Promise<SourceInfo> { return call<SourceInfo>(`/.well-known/source`); }
export const sourceLinkUrl = `${API_BASE}/source`;
