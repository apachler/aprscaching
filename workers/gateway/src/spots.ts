/**
 * spots.ts — live activity-spots aggregation (docs/20 §1, milestone S1). Polls read-only spot
 * sources (POTA now; SOTA/WWBOTA/GMA next), normalizes to the shared `Spot` shape, dedupes across
 * sources, and serves `GET /api/spots?bbox=&bands=&modes=&sources=`.
 *
 * Cost (docs/20 §4): aggregation is lazy + TTL-cached in-process (default 60 s) so we never run a
 * per-client firehose; nothing is persisted. Disabled by default (SPOTS_ENABLED) so CI/offline never
 * makes outbound calls — the pure normalize/dedup/filter logic is unit-tested with fixtures instead.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { type Spot, type SpotSource, bandForHz, freqToHz, dedupeSpots, filterSpots } from "@aprsweb/shared";

const truthy = (v?: string) => v === "1" || v === "true" || v === "yes";

/** A normalizer turns one source's raw JSON into Spots (coords required; spots without lat/lon dropped). */
interface SourceDef { source: SpotSource; url: (env: Env) => string; normalize: (raw: unknown) => Spot[] }

const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : undefined;
};
const pick = (o: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) if (o[k] != null && o[k] !== "") return o[k];
  return undefined;
};
const toUnix = (v: unknown): number => {
  if (typeof v === "number") return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? Math.floor(t / 1000) : Math.floor(Date.now() / 1000);
};

/** POTA — api.pota.app/spot/activator: array of activator spots carrying lat/lon. */
export function normalizePota(raw: unknown): Spot[] {
  if (!Array.isArray(raw)) return [];
  const out: Spot[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    const lat = num(pick(r, "latitude", "lat")), lon = num(pick(r, "longitude", "lon", "lng"));
    const callsign = String(pick(r, "activator", "callsign", "call") ?? "").toUpperCase();
    if (lat == null || lon == null || !callsign) continue;
    const freqHz = freqToHz(pick(r, "frequency", "freq") as string | number | undefined);
    out.push({
      id: `pota:${pick(r, "spotId", "id") ?? `${callsign}:${pick(r, "reference") ?? ""}`}`,
      source: "pota", callsign,
      ref: (pick(r, "reference", "ref") as string) || undefined,
      name: (pick(r, "name", "parkName", "locationName") as string) || undefined,
      lat, lon, freqHz, band: bandForHz(freqHz),
      mode: (pick(r, "mode") as string)?.toUpperCase() || undefined,
      comment: (pick(r, "comments", "comment", "text") as string) || undefined,
      spottedAt: toUnix(pick(r, "spotTime", "timeStamp", "time", "spottedAt")),
    });
  }
  return out;
}

const SOURCES: SourceDef[] = [
  { source: "pota", url: (env) => env.SPOTS_POTA_URL || "https://api.pota.app/spot/activator", normalize: normalizePota },
  // S3: SOTA (needs summit→coord resolution), GMA/WWBOTA (cqgma.org), DX-cluster, RBN/PSKReporter.
];

/** Which sources are enabled for this instance (master switch + optional allowlist). */
function enabledSources(env: Env): SourceDef[] {
  if (!truthy(env.SPOTS_ENABLED)) return [];
  const only = (env.SPOTS_SOURCES || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return only.length ? SOURCES.filter((s) => only.includes(s.source)) : SOURCES;
}

let cache: { at: number; spots: Spot[] } | null = null;

async function fetchSource(def: SourceDef, env: Env): Promise<Spot[]> {
  try {
    const res = await fetch(def.url(env), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    return def.normalize(await res.json());
  } catch { return []; } // a down source must never break the others
}

/** Aggregate (lazy, TTL-cached, deduped). Returns [] when spots are disabled. */
export async function getSpots(env: Env): Promise<Spot[]> {
  const sources = enabledSources(env);
  if (!sources.length) return [];
  const ttlMs = (Number(env.SPOTS_TTL_SEC) || 60) * 1000;
  const nowMs = Date.now();
  if (cache && nowMs - cache.at < ttlMs) return cache.spots;
  const batches = await Promise.all(sources.map((s) => fetchSource(s, env)));
  const spots = dedupeSpots(batches.flat());
  cache = { at: nowMs, spots };
  return spots;
}

/** Test seam: reset the in-process cache. */
export function _resetSpotsCache(): void { cache = null; }

const csv = (v: string | null) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

/** GET /api/spots?bbox=minLon,minLat,maxLon,maxLat&bands=20m,2m&modes=SSB&sources=pota */
export async function handleSpots(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const enabled = truthy(env.SPOTS_ENABLED);
  const bboxRaw = csv(u.searchParams.get("bbox"))?.map(Number);
  const bbox = bboxRaw && bboxRaw.length === 4 && bboxRaw.every(Number.isFinite)
    ? (bboxRaw as [number, number, number, number]) : undefined;
  const all = await getSpots(env);
  const spots = filterSpots(all, { bbox, bands: csv(u.searchParams.get("bands")), modes: csv(u.searchParams.get("modes")), sources: csv(u.searchParams.get("sources")) });
  return json({ enabled, count: spots.length, fetchedAt: cache?.at ? Math.floor(cache.at / 1000) : null, spots });
}
