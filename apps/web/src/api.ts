import type {
  CacheSummary, CacheDetail, CreateCacheRequest, UpdateCacheRequest,
  MapCache, LogType, AppGeo, TrustTier, LeaderboardEntry, Profile,
  StationSummary, StationDetail, DecodedPacket, PortStat, MessageItem, Spot,
} from "@aprsweb/shared";

export type { CacheSummary, CacheDetail, CreateCacheRequest, MapCache, LogType, AppGeo, TrustTier, LeaderboardEntry, Profile, StationSummary, StationDetail, DecodedPacket, PortStat, MessageItem, Spot };

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
export function decodePacket(raw: string): Promise<DecodedPacket> {
  return call(`/api/decode`, { method: "POST", body: JSON.stringify({ raw }) });
}
export function getPorts(): Promise<{ window: string; ports: PortStat[] }> {
  return call(`/api/ports`);
}
export function getMessages(bulletins = false): Promise<{ messages: MessageItem[] }> {
  return call(`/api/messages?limit=30${bulletins ? "&bulletins=1" : ""}`);
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
export interface WatchAlert { id: number; callsign: string; kind: "heard" | "near_cache"; detail?: string; cacheId?: number | null; lat?: number | null; lon?: number | null; ts: number; seen: boolean; }
export function listWatch(): Promise<{ watching: WatchEntry[]; unseen: number }> { return call(`/api/watch`); }
export function addWatch(callsign: string): Promise<{ ok: boolean; callsign: string }> { return call(`/api/watch`, { method: "POST", body: JSON.stringify({ callsign }) }); }
export function removeWatch(callsign: string): Promise<{ ok: boolean }> { return call(`/api/watch/${encodeURIComponent(callsign)}`, { method: "DELETE" }); }
export function getWatchAlerts(): Promise<{ alerts: WatchAlert[] }> { return call(`/api/watch/alerts`); }
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
