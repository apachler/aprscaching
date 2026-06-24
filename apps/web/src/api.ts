import type {
  CacheSummary, CacheDetail, CreateCacheRequest, UpdateCacheRequest,
  MapCache, LogType, AppGeo, TrustTier, LeaderboardEntry, Profile,
  StationSummary, StationDetail, DecodedPacket, PortStat, MessageItem,
} from "@aprsweb/shared";

export type { CacheSummary, CacheDetail, CreateCacheRequest, MapCache, LogType, AppGeo, TrustTier, LeaderboardEntry, Profile, StationSummary, StationDetail, DecodedPacket, PortStat, MessageItem };

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

export function listCaches(bbox: BBox): Promise<{ caches: MapCache[] }> {
  return call(`/api/caches?bbox=${bbox.join(",")}`);
}

export function getCache(id: number, callsign?: string): Promise<{ cache: CacheDetail }> {
  return call(`/api/caches/${id}${callsign ? `?callsign=${encodeURIComponent(callsign)}` : ""}`);
}

export function getLeaderboard(bbox: BBox, metric: "finds" | "points"): Promise<{ leaderboard: LeaderboardEntry[] }> {
  return call(`/api/leaderboard?metric=${metric}&bbox=${bbox.join(",")}`);
}
export function getProfile(callsign: string): Promise<Profile> {
  return call(`/api/profile/${encodeURIComponent(callsign)}`);
}
import type { ActivityItem } from "@aprsweb/shared";
export type { ActivityItem };
export function getActivity(bbox?: BBox): Promise<{ activity: ActivityItem[] }> {
  return call(`/api/activity?limit=30${bbox ? `&bbox=${bbox.join(",")}` : ""}`);
}
export function toggleFavorite(cacheId: number, callsign: string, on: boolean): Promise<{ on: boolean; count: number }> {
  return call(`/api/caches/${cacheId}/favorite`, { method: "POST", body: JSON.stringify({ callsign, on }) });
}

// ---- M5 workbench: live stations + packet inspector ----
export function getStations(bbox: BBox): Promise<{ stations: StationSummary[] }> {
  return call(`/api/stations?bbox=${bbox.join(",")}`);
}
export function getStation(callsign: string): Promise<{ station: StationDetail }> {
  return call(`/api/stations/${encodeURIComponent(callsign)}`);
}
export function decodePacket(raw: string): Promise<DecodedPacket> {
  return call(`/api/decode`, { method: "POST", body: JSON.stringify({ raw }) });
}
export function getPorts(): Promise<{ window: string; ports: PortStat[] }> {
  return call(`/api/ports`);
}
export function getMessages(bulletins = false): Promise<{ messages: MessageItem[] }> {
  return call(`/api/messages?limit=30${bulletins ? "&bulletins=1" : ""}`);
}
/** Public CoT/TAK feed URL for the current viewport (paste into ATAK as a data feed). */
export function cotUrl(bbox: BBox): string {
  return `${API_BASE}/api/cot?bbox=${bbox.join(",")}`;
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
}

export interface AuthorSig { authorKey: string; authorSig: string; signedAt: number }

export function logFind(
  cacheId: number,
  body: { loggerCall: string; logType: LogType; comment?: string; appGeo?: AppGeo; author?: AuthorSig },
): Promise<LogResult> {
  return call(`/api/caches/${cacheId}/logs`, { method: "POST", body: JSON.stringify(body) });
}

export function registerKey(body: { callsign: string; publicKey: string; label?: string }): Promise<{ ok: boolean }> {
  return call(`/keys/register`, { method: "POST", body: JSON.stringify(body) });
}

let instanceCache: Promise<string> | null = null;
/** This instance's federation id (cached), used to build the canonical authorship message. */
export function getInstance(): Promise<string> {
  if (!instanceCache) instanceCache = call<{ instance: string }>(`/.well-known/aprscaching`).then((d) => d.instance).catch(() => "");
  return instanceCache;
}
