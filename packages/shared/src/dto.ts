// SPDX-License-Identifier: MIT
import { z } from "zod";
import { DxccPrefix } from "./dxcc.js";

export const CacheType = z.enum([
  "traditional", // one spot to find
  "multi", // several stages, each revealed by the previous one
  "aprs_living",
  "audio",
  "virtual",
  "sota",
  "pota",
  "wwff",
  "bunker",
  "castle",
]);
export type CacheType = z.infer<typeof CacheType>;

export const CacheStatus = z.enum(["active", "disabled", "archived"]);
export type CacheStatus = z.infer<typeof CacheStatus>;

export const TrustTier = z.enum(["A", "B", "C"]);
export type TrustTier = z.infer<typeof TrustTier>;

/** Per-cache minimum-trust override: only A or B may be required (C = "no requirement"). */
export const MinTrust = z.enum(["A", "B"]);

/** How far a cache federates: public (default), unlisted (no description), local-only (never federates). */
export const FedScope = z.enum(["public", "unlisted", "local-only"]);
export type FedScope = z.infer<typeof FedScope>;

export const LogType = z.enum(["found", "dnf", "note", "maintenance", "enabled", "disabled"]);
export type LogType = z.infer<typeof LogType>;

const Lat = z.number().min(-90).max(90);
const Lon = z.number().min(-180).max(180);
const DT = z.number().min(1).max(5);
const Callsign = z
  .string()
  .trim()
  .min(3)
  .max(9)
  .regex(/^[A-Za-z0-9-]+$/);

/**
 * The in-app location evidence: one reading the device's geolocation reported, with the reading's own
 * timestamp (unix seconds) and accuracy. It is strict: no field can mark a typed coordinate, because a
 * coordinate the user typed is their claim, never evidence of where the device was.
 */
export const AppGeo = z
  .object({
    lat: Lat,
    lon: Lon,
    accuracyM: z.number().nonnegative(),
    ts: z.number(),
  })
  .strict();
export type AppGeo = z.infer<typeof AppGeo>;

/**
 * Unlock the next stage of a multi-stage cache. A geo stage takes the device reading (`appGeo`, where
 * accuracy and timestamp are optional); an NFC stage takes the tag's `code`.
 */
export const StageUnlockRequest = z.object({
  callsign: z.string().optional(),
  appGeo: AppGeo.partial({ accuracyM: true, ts: true }).optional(),
  code: z.string().optional(),
});

/** Owner "hide a cache" — create a native cache. Owner taken from session, else `ownerCall`. */
/** Free-form cache tags: up to 12, each a short trimmed token (deduped + lowercased by the gateway). */
export const CacheTags = z.array(z.string().trim().min(1).max(24)).max(12);

/** Who may rate a cache (owner-gated): only finders (default), any signed-in caller, or nobody. */
export const RatingPolicy = z.enum(["finders", "all", "off"]);
export type RatingPolicy = z.infer<typeof RatingPolicy>;

/** Submit a 1–5 star rating for a cache. */
export const RateRequest = z.object({
  callsign: Callsign.optional(), // omitted by signed-in web (attributed to the session)
  stars: z.number().int().min(1).max(5),
});
export type RateRequest = z.infer<typeof RateRequest>;

export const CreateCacheRequest = z.object({
  title: z.string().trim().min(1).max(120),
  type: CacheType.default("traditional"),
  lat: Lat,
  lon: Lon,
  difficulty: DT.default(1.5),
  terrain: DT.default(1.5),
  ownerCall: Callsign.optional(),
  stationCall: Callsign.optional(), // aprs_living: the beaconing station that IS the cache
  hint: z.string().max(500).optional(),
  description: z.string().max(4000).optional(),
  minTrust: MinTrust.optional(),
  fedScope: FedScope.default("public"), // how far this cache federates
  code: z.string().trim().max(32).optional(), // explicit code (imports); else AC-#### is minted
  driveIn: z.boolean().optional(), // car-accessible cache (original APRSCaching "Drive-In")
  country: z.union([z.literal(""), DxccPrefix]).optional(), // a DXCC prefix; "" clears it
  tags: CacheTags.optional(),
  ratingPolicy: RatingPolicy.optional(), // who may rate; default 'finders'
  rendezvous: z.boolean().optional(), // living cache opts into mutual rendezvous logging
});
export type CreateCacheRequest = z.infer<typeof CreateCacheRequest>;

/** Owner edit. Every field optional; `status` lets an owner disable/archive a cache. */
export const UpdateCacheRequest = z.object({
  ownerCall: Callsign.optional(), // advisory actor identity until passkey sessions land
  title: z.string().trim().min(1).max(120).optional(),
  type: CacheType.optional(),
  status: CacheStatus.optional(),
  lat: Lat.optional(),
  lon: Lon.optional(),
  difficulty: DT.optional(),
  terrain: DT.optional(),
  stationCall: Callsign.optional(),
  hint: z.string().max(500).optional(),
  description: z.string().max(4000).optional(),
  minTrust: MinTrust.nullable().optional(), // null: back to the instance's minimum
  fedScope: FedScope.optional(), // change federation scope
  driveIn: z.boolean().optional(),
  country: z.union([z.literal(""), DxccPrefix]).optional(), // a DXCC prefix; "" clears it
  tags: CacheTags.optional(),
  ratingPolicy: RatingPolicy.optional(),
  rendezvous: z.boolean().optional(),
});
export type UpdateCacheRequest = z.infer<typeof UpdateCacheRequest>;

const B64 = z.string().trim().min(16).max(512);

/** Per-callsign signature attesting the logger authored this find. */
export const AuthorSig = z.object({
  authorKey: B64, // Ed25519 public key (raw, base64url)
  authorSig: B64, // signature over authorshipMessage(...)
  signedAt: z.number().int(), // client authorship time the signature covers
});

/** A log entry against a cache (found/DNF/note/…), posted to /api/caches/:id/logs. Verification only runs for `found`. */
export const LogRequest = z.object({
  loggerCall: Callsign.optional(), // omitted by signed-in web (attributed to the session)
  logType: LogType.default("found"),
  comment: z.string().max(2000).optional(),
  appGeo: AppGeo.optional(),
  author: AuthorSig.optional(),
  // the log waited in the client's offline queue; only labels an unsigned log, whose time is its arrival
  offline: z.boolean().optional(),
});
export type LogRequest = z.infer<typeof LogRequest>;

/** Bind a device public key to a callsign. */
export const RegisterKeyRequest = z.object({
  callsign: Callsign,
  publicKey: B64,
  label: z.string().max(64).optional(),
});
export type RegisterKeyRequest = z.infer<typeof RegisterKeyRequest>;

// ---- response shapes (worker maps D1 rows -> these camelCase DTOs) ----

/** One run of an imported place's attribution note: plain text, linked when the source linked it. */
export interface AttributionPart {
  text: string;
  href?: string; // http(s) only
}

export interface CacheSummary {
  id: number;
  code: string;
  ownerCall: string;
  title: string;
  type: CacheType;
  status: CacheStatus;
  difficulty: number;
  terrain: number;
  lat: number | null;
  lon: number | null;
  stationCall: string | null;
  source: string;
  sourceName: string | null; // attribution label when imported
  sourceUrl: string | null; // deep link to the source page
  /** The author's name at the import source (an OpenCaching user name); null for native caches. */
  sourceOwner: string | null;
  /** The source's own attribution note, as text parts with optional links; null when it gives none. */
  sourceAttribution: AttributionPart[] | null;
  minTrust: "A" | "B" | null;
  fedScope: FedScope; // owner's federation scope
  driveIn: boolean; // car-accessible (original APRSCaching "Drive-In")
  country: string | null; // the DXCC prefix of the country (owner-set)
  tags: string[]; // free-form tags
}

/** A cache as it appears on the map — native or mirrored from a federation peer. */
export interface MapCache {
  globalId: string; // network-unique id, e.g. "oe.aprscaching.org:cache:42"
  id: number | null; // local numeric id (native only; null when mirrored)
  code: string;
  ownerCall: string;
  title: string;
  type: CacheType;
  status: CacheStatus;
  difficulty: number;
  terrain: number;
  lat: number | null;
  lon: number | null;
  origin: string; // originating instance id
  mirrored: boolean;
  originTrust: "native" | "trusted" | "unvetted"; // first-party, or the origin peer's trust tier (blocked never surfaced)
  source: string; // "native" or an import source ("sota","pota",…)
  sourceName: string | null; // attribution label for imported caches
  sourceUrl: string | null; // deep link to the source page
  /** The owner's country and tags; a mirrored cache carries neither. */
  country: string | null;
  tags: string[];
}

export interface CacheLogEntry {
  id: number;
  cacheId: number;
  loggerCall: string;
  ts: number;
  logType: LogType;
  verified: boolean;
  tier: TrustTier | null;
  verifyMethod: string | null;
  distanceM: number | null;
  comment: string | null;
  corroboratedBy?: string | null; // peer instance that corroborated a Tier-A find
  corroboratedLaterAt?: number | null; // when a later attempt lifted the find to Tier A (unix seconds)
  signerKey?: string | null; // logger's device key that signed this find
  receivedAt?: number | null; // when the instance received the log; ts is the find time (unix seconds)
  // why ts is the receive time and not the signed field time (future, too_old, before_cache, before_key, unsigned)
  fieldTimeRejected?: string | null;
}

export interface CacheDetail extends CacheSummary {
  hint: string | null;
  description: string | null;
  externalId: string | null;
  createdAt: number;
  updatedAt: number;
  finds: number; // count of verified found logs
  findsByMonth?: { month: string; n: number }[]; // monthly verified-find counts (sparkline), oldest→newest
  logs: CacheLogEntry[]; // first keyset page, newest first
  logsCursor?: string | null; // cursor for the next logbook page, null if none
  logsHasMore?: boolean; // true when older logs exist beyond the embedded page
  // community
  favorites: number;
  favorited: boolean;
  needsMaintenance: boolean;
  dnfStreak: number;
  lastFound: number | null;
  // owner-gated rating
  rating: { avg: number | null; count: number; mine: number | null; policy: RatingPolicy; canRate: boolean };
  // living-cache rendezvous: recent meetings (empty unless this is a rendezvous living cache). Only the cache's
  // owner gets the time and place; anyone else gets the day (`day`, `ts` at its noon UTC) and no position.
  rendezvous: {
    withCacheId: number;
    withCall: string;
    ts: number;
    lat: number | null;
    lon: number | null;
    day?: boolean;
  }[];
  // audio-cache
  stageCount: number;
  /** A living cache: the time of its station's position, which is the cache's; null while the station has none. */
  stationHeardAt?: number | null;
  /** For the cache's owner only: the settings the edit form starts from that the fields above do not carry. */
  own?: { minTrust: "A" | "B" | null; rendezvous: boolean };
}

// ---- audio-cache: staged multi-cache ----
export interface CacheStage {
  stageNo: number;
  unlock: "geo" | "audio" | "open" | "nfc";
  clue: string | null;
  mediaUrl: string | null;
  radiusM: number;
  unlocked: boolean;
  lat: number | null; // revealed only when unlocked, and always to the cache's owner
  lon: number | null;
  /** An NFC stage's tag code, for the cache's owner only. */
  secret?: string | null;
}

// ---- enriched search: as-you-type suggestions across caches + stations ----
export interface SearchHitCache {
  kind: "cache";
  id: number;
  code: string;
  title: string;
  ownerCall: string;
  type: CacheType;
  lat: number | null;
  lon: number | null;
}
export interface SearchHitStation {
  kind: "station";
  callsign: string;
  symbol: string | null;
  comment: string | null;
  lat: number | null;
  lon: number | null;
}
export interface SearchResults {
  caches: SearchHitCache[];
  stations: SearchHitStation[];
}

// ---- community response shapes ----
export interface LeaderboardEntry {
  rank: number;
  loggerCall: string;
  finds: number;
  points: number;
}
export interface Badge {
  badge: string;
  earnedAt: number;
}
export interface ProfileCard {
  displayName?: string;
  homeGrid?: string;
  avatarUrl?: string;
  bio?: string;
  links?: { label: string; url: string }[];
  publicContact?: string;
}
export interface Profile {
  callsign: string;
  accountVerified: boolean;
  homeInstance?: string; // the instance this operator is homed at; shown as "homed at …"
  supporter?: boolean; // recognition badge; never affects functionality
  finds: number;
  points: number;
  firstFind: number | null;
  lastFind: number | null;
  hides: number;
  corroborations?: number; // Tier-A finds this operator's IGate(s) helped verify
  byTier: Record<string, number>;
  byType: Record<string, number>;
  badges: Badge[];
  profile?: ProfileCard; // opt-in self-curated card
}

/** A row in the corroborator leaderboard — an IGate ranked by Tier-A finds it helped verify. */
export interface Corroborator {
  rank: number;
  igate: string;
  corroborations: number;
}
export interface ActivityItem {
  id: number;
  loggerCall: string;
  ts: number;
  logType: string;
  verified: boolean;
  tier: string | null;
  cacheId: number;
  cacheCode: string;
  cacheTitle: string;
}

// ---- shack: live APRS stations + packet inspector ----
export interface StationSummary {
  callsign: string;
  lat: number;
  lon: number;
  symbol: string | null;
  course: number | null;
  speedKn: number | null;
  altitudeM: number | null;
  comment: string | null;
  lastSeen: number;
  roles?: StationRole[]; // operated-station roles, when this callsign is in the registry
}
export interface StationTrackPoint {
  ts: number;
  lat: number;
  lon: number;
  heardVia: string;
}
export interface WxReading {
  ts: number;
  tempC: number | null;
  humidity: number | null;
  pressureHpa: number | null;
  windDirDeg: number | null;
  windKn: number | null;
  rainMm: number | null;
}
export interface StationDetail extends StationSummary {
  track: StationTrackPoint[];
  wx: WxReading | null;
  packets: number;
  /** In an operator's registry of stations (anyone's). */
  registered: boolean;
  /** In the signed-in viewer's own registry. */
  mine: boolean;
}

// ---- operated-stations registry: the operator's own stations ----
/** The roles a user's operated station can carry. Weather is one capability; the rest are RF infra. */
export const STATION_ROLES = ["weather", "digipeater", "igate", "node", "relay"] as const;
export type StationRole = (typeof STATION_ROLES)[number];
/** A weather-capable station's PWS push key + ready-to-paste ingest URLs (null until issued). */
export interface StationWxKey {
  key: string | null;
  lastSeen: number | null;
  ecowittPath: string | null;
  wuUrl: string | null;
  txIs?: boolean;
  txCwop?: boolean;
  verified?: boolean; // APRS-IS weather beacon / CWOP relay TX opt-in + control-verified gate
}
export interface OperatedStation {
  id: number;
  callsign: string; // full callsign incl. SSID
  lat: number | null;
  lon: number | null;
  symbol: string | null;
  description: string | null;
  roles: StationRole[];
  createdAt: number;
  updatedAt: number;
  wx?: StationWxKey; // present only on weather-capable stations
  /** The living caches riding this station, in the list only; absent when there are none. */
  livingCaches?: { id: number; code: string; title: string; rendezvous: boolean }[];
}
/** Result of POST /api/decode — the parsed frame plus the typed APRS data. */
export interface DecodedPacket {
  ok: boolean;
  frame?: { src: string; dst: string; path: string[]; payload: string; heardVia: string; igateCall?: string };
  data?: Record<string, unknown> & { kind: string };
  error?: string;
}

// ---- interop: transports + messaging ----
export interface PortStat {
  port: string;
  rx: number;
  tx: number;
  lastBucket: number;
}
export interface MessageItem {
  id: number;
  ts: number;
  fromCall: string;
  toCall: string | null;
  body: string;
  direction: string;
  /** The network that carried it (a `Transport` value); null on a row stored without one. */
  transport?: string | null;
}

/** A MeshCom group heard within the message retention (`*` is the all-stations group). */
export interface MeshcomGroup {
  group: string;
  messages: number;
  lastHeard: number;
}

/** One MeshCom group message, as the operator's own node(s) heard it. */
export interface MeshcomGroupMessage {
  id: number;
  ts: number;
  fromCall: string;
  body: string;
  /** The node that heard it. */
  receiver: string | null;
  /** How that node heard it: direct or relayed over LoRa, from the MeshCom server, or its own frame. */
  heard: "direct" | "relayed" | "server" | "node" | null;
}

// ---- BBS store-and-forward ----
export interface BbsMessage {
  id: number;
  bid: string | null;
  type: "P" | "B" | "T";
  fromCall: string;
  toCall: string;
  subject: string | null;
  body: string;
  postedAt: number;
  origin: string;
  readAt: number | null;
  replyTo?: number | null;
  threadId?: number | null; // FBB thread tree
  /** Personal mail you sent: the partner BBSes FBB forwarding passed it to. */
  forwardedTo?: string[];
}

/**
 * A station callsign: a base call with an optional numeric SSID (`OE8ABC`, `OE8ABC-10`). The gateway takes
 * receiving-site calls in this form only, and the web app checks its forms against the same pattern.
 */
export const SITE_CALL_RE = /^[A-Z0-9]{3,9}(-[0-9]{1,2})?$/;
