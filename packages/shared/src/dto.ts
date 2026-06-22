import { z } from "zod";

export const CacheType = z.enum([
  "single", "two_stage", "multi", "aprs_living", "audio", "traditional", "sota", "pota",
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

/** A log entry against a cache (found/DNF/note/…). Verification only runs for `found`. */
export const LogRequest = z.object({
  cacheId: z.number().int().positive(),
  loggerCall: Callsign,
  logType: LogType.default("found"),
  comment: z.string().max(2000).optional(),
  appGeo: AppGeo.optional(),
});
export type LogRequest = z.infer<typeof LogRequest>;

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
  minTrust: "A" | "B" | null;
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
}

export interface CacheDetail extends CacheSummary {
  hint: string | null;
  description: string | null;
  externalId: string | null;
  createdAt: number;
  updatedAt: number;
  finds: number;       // count of verified found logs
  logs: CacheLogEntry[];
}
