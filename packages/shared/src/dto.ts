import { z } from "zod";

export const CacheType = z.enum([
  "single", "two_stage", "multi", "aprs_living", "audio", "traditional", "sota", "pota",
  "wwff", "bunker", "castle",
]);
export type CacheType = z.infer<typeof CacheType>;

export const CacheStatus = z.enum(["active", "disabled", "archived"]);
export type CacheStatus = z.infer<typeof CacheStatus>;

export const TrustTier = z.enum(["A", "B", "C"]);
export type TrustTier = z.infer<typeof TrustTier>;

/** Per-cache minimum-trust override: only A or B may be required (C = "no requirement"). */
export const MinTrust = z.enum(["A", "B"]);

export const LogType = z.enum([
  "found", "dnf", "note", "maintenance", "enabled", "disabled",
]);
export type LogType = z.infer<typeof LogType>;

const Lat = z.number().min(-90).max(90);
const Lon = z.number().min(-180).max(180);
const DT = z.number().min(1).max(5);
const Callsign = z.string().trim().min(3).max(9).regex(/^[A-Za-z0-9-]+$/);

export const AppGeo = z.object({
  lat: Lat, lon: Lon, accuracyM: z.number().nonnegative(), ts: z.number(),
});
export type AppGeo = z.infer<typeof AppGeo>;

/** Owner "hide a cache" — create a native cache. Owner taken from session, else `ownerCall`. */
export const CreateCacheRequest = z.object({
  title: z.string().trim().min(1).max(120),
  type: CacheType.default("single"),
  lat: Lat,
  lon: Lon,
  difficulty: DT.default(1.5),
  terrain: DT.default(1.5),
  ownerCall: Callsign.optional(),
  stationCall: Callsign.optional(),     // aprs_living: the beaconing station that IS the cache
  hint: z.string().max(500).optional(),
  description: z.string().max(4000).optional(),
  minTrust: MinTrust.optional(),
  code: z.string().trim().max(32).optional(),  // explicit code (imports); else AC-#### is minted
});
export type CreateCacheRequest = z.infer<typeof CreateCacheRequest>;

/** Owner edit. Every field optional; `status` lets an owner disable/archive a cache. */
export const UpdateCacheRequest = z.object({
  ownerCall: Callsign.optional(),       // advisory actor identity until passkey sessions land
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
  minTrust: MinTrust.optional(),
});
export type UpdateCacheRequest = z.infer<typeof UpdateCacheRequest>;

const B64 = z.string().trim().min(16).max(512);

/** Per-callsign signature attesting the logger authored this find (F0). */
export const AuthorSig = z.object({
  authorKey: B64,                 // Ed25519 public key (raw, base64url)
  authorSig: B64,                 // signature over authorshipMessage(...)
  signedAt: z.number().int(),     // client authorship time the signature covers
});

/** A log entry against a cache (found/DNF/note/…). Verification only runs for `found`. */
export const LogRequest = z.object({
  cacheId: z.number().int().positive().optional(),  // omitted when posted to /api/caches/:id/logs
  loggerCall: Callsign,
  logType: LogType.default("found"),
  comment: z.string().max(2000).optional(),
  appGeo: AppGeo.optional(),
  author: AuthorSig.optional(),
});
export type LogRequest = z.infer<typeof LogRequest>;

/** Bind a device public key to a callsign (F0). */
export const RegisterKeyRequest = z.object({
  callsign: Callsign,
  publicKey: B64,
  label: z.string().max(64).optional(),
});
export type RegisterKeyRequest = z.infer<typeof RegisterKeyRequest>;

/** Back-compat: the original find request (a `found` LogRequest without an explicit logType). */
export const LogFindRequest = LogRequest;
export type LogFindRequest = LogRequest;

// ---- response shapes (worker maps D1 rows -> these camelCase DTOs) ----

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
  sourceName: string | null;   // attribution label when imported
  sourceUrl: string | null;    // deep link to the source page
  minTrust: "A" | "B" | null;
}

/** A cache as it appears on the map — native or mirrored from a federation peer (F2). */
export interface MapCache {
  globalId: string;          // network-unique id, e.g. "oe.aprscaching.org:cache:42"
  id: number | null;         // local numeric id (native only; null when mirrored)
  code: string;
  ownerCall: string;
  title: string;
  type: CacheType;
  status: CacheStatus;
  difficulty: number;
  terrain: number;
  lat: number | null;
  lon: number | null;
  origin: string;            // originating instance id
  mirrored: boolean;
  source: string;            // "native" or an import source ("sota","pota",…)
  sourceName: string | null; // attribution label for imported caches
  sourceUrl: string | null;  // deep link to the source page
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
  corroboratedBy?: string | null;   // peer instance that corroborated a Tier-A find (F3)
  signerKey?: string | null;        // logger's device key that signed this find (F0)
}

export interface CacheDetail extends CacheSummary {
  hint: string | null;
  description: string | null;
  externalId: string | null;
  createdAt: number;
  updatedAt: number;
  finds: number;       // count of verified found logs
  logs: CacheLogEntry[];
  // M4 community
  favorites: number;
  favorited: boolean;
  needsMaintenance: boolean;
  dnfStreak: number;
  lastFound: number | null;
  // M2 audio-cache
  stageCount: number;
}

// ---- M2 audio-cache: staged multi-cache ----
export interface CacheStage {
  stageNo: number;
  unlock: "geo" | "audio" | "open";
  clue: string | null;
  mediaUrl: string | null;
  radiusM: number;
  unlocked: boolean;
  lat: number | null;   // revealed only when unlocked
  lon: number | null;
}

// ---- M4 community response shapes ----
export interface LeaderboardEntry { rank: number; loggerCall: string; finds: number; points: number }
export interface Badge { badge: string; earnedAt: number }
export interface Profile {
  callsign: string; accountVerified: boolean;
  finds: number; points: number; firstFind: number | null; lastFind: number | null; hides: number;
  byTier: Record<string, number>; byType: Record<string, number>; badges: Badge[];
}
export interface ActivityItem {
  id: number; loggerCall: string; ts: number; logType: string; verified: boolean; tier: string | null;
  cacheId: number; cacheCode: string; cacheTitle: string;
}

// ---- M5 workbench: live APRS stations + packet inspector ----
export interface StationSummary {
  callsign: string; lat: number; lon: number; symbol: string | null;
  course: number | null; speedKn: number | null; altitudeM: number | null;
  comment: string | null; lastSeen: number;
}
export interface StationTrackPoint { ts: number; lat: number; lon: number; heardVia: string }
export interface WxReading {
  ts: number; tempC: number | null; humidity: number | null; pressureHpa: number | null;
  windDirDeg: number | null; windKn: number | null; rainMm: number | null;
}
export interface StationDetail extends StationSummary {
  track: StationTrackPoint[];
  wx: WxReading | null;
  packets: number;
}
/** Result of POST /api/decode — the parsed frame plus the typed APRS data. */
export interface DecodedPacket {
  ok: boolean;
  frame?: { src: string; dst: string; path: string[]; payload: string; heardVia: string; igateCall?: string };
  data?: Record<string, unknown> & { kind: string };
  error?: string;
}

// ---- M6 interop: transports + messaging ----
export interface PortStat { port: string; rx: number; tx: number; lastBucket: number }
export interface MessageItem { id: number; ts: number; fromCall: string; toCall: string | null; body: string; direction: string }
