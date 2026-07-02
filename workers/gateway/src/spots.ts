// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * spots.ts — live activity-spots aggregation. Polls read-only spot
 * sources (POTA now; SOTA/WWBOTA/GMA next), normalizes to the shared `Spot` shape, dedupes across
 * sources, and serves `GET /api/spots?bbox=&bands=&modes=&sources=`.
 *
 * Cost: aggregation is lazy + TTL-cached in-process (default 60 s) so we never run a
 * per-client firehose; nothing is persisted. Disabled by default (SPOTS_ENABLED) so CI/offline never
 * makes outbound calls — the pure normalize/dedup/filter logic is unit-tested with fixtures instead.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { type Spot, type SpotSource, bandForHz, freqToHz, gridToLatLon, dedupeSpots, filterSpots } from "@aprsweb/shared";

const truthy = (v?: string) => v === "1" || v === "true" || v === "yes";

/** A normalizer turns one source's raw JSON into Spots (coords required; spots without lat/lon dropped). */
interface SourceDef { source: SpotSource; url: (env: Env) => string; normalize: (raw: unknown, env: Env) => Spot[] | Promise<Spot[]> }

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

/** GMA / WWBOTA (cqgma.org) — `{ RCD: [...] }` (or a bare array) of spots that carry coordinates. */
export function normalizeGma(raw: unknown): Spot[] {
  const arr = Array.isArray(raw) ? raw : Array.isArray((raw as { RCD?: unknown[] })?.RCD) ? (raw as { RCD: unknown[] }).RCD : [];
  const out: Spot[] = [];
  for (const r of arr as Record<string, unknown>[]) {
    const lat = num(pick(r, "LAT", "latitude", "lat")), lon = num(pick(r, "LON", "longitude", "lon"));
    const callsign = String(pick(r, "ACTIVATOR", "CALL", "callsign", "activator") ?? "").toUpperCase();
    if (lat == null || lon == null || !callsign) continue;
    const freqHz = freqToHz(pick(r, "QRG", "FREQUENCY", "frequency", "freq") as string | number | undefined);
    // GMA carries DATE ("2024-06-01") + TIME ("1200"/"12:00") separately
    const dateRaw = pick(r, "DATE", "date"), timeRaw = String(pick(r, "TIME", "time") ?? "").replace(/:/g, "");
    const when = dateRaw ? `${dateRaw}T${timeRaw.padEnd(4, "0").slice(0, 2)}:${timeRaw.padEnd(4, "0").slice(2, 4)}:00Z` : pick(r, "spotTime", "timestamp");
    out.push({
      id: `gma:${pick(r, "ID", "id") ?? `${callsign}:${pick(r, "REF", "ref") ?? ""}`}`,
      source: "gma", callsign,
      ref: (pick(r, "REF", "ref", "reference") as string) || undefined,
      name: (pick(r, "NAME", "name") as string) || undefined,
      lat, lon, freqHz, band: bandForHz(freqHz),
      mode: (pick(r, "MODE", "mode") as string)?.toUpperCase() || undefined,
      comment: (pick(r, "TEXT", "comment", "comments") as string) || undefined,
      spottedAt: toUnix(when),
    });
  }
  return out;
}

// SOTA spots carry a summit code but no coordinates → resolve via the summits API, cached per code.
const sotaSummits = new Map<string, { lat: number; lon: number; name?: string }>();
async function sotaCoords(env: Env, code: string): Promise<{ lat: number; lon: number; name?: string } | null> {
  if (sotaSummits.has(code)) return sotaSummits.get(code)!;
  try {
    const base = env.SPOTS_SOTA_SUMMITS_URL || "https://api-db2.sota.org.uk/api/summits/";
    const res = await fetch(`${base}${encodeURIComponent(code)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const d = (await res.json()) as Record<string, unknown>;
    const lat = num(pick(d, "latitude", "lat")), lon = num(pick(d, "longitude", "lon"));
    if (lat == null || lon == null) return null;
    const v = { lat, lon, name: (pick(d, "name", "summitName") as string) || undefined };
    sotaSummits.set(code, v);
    return v;
  } catch { return null; }
}

/** SOTA — api2.sota.org.uk/api/spots: array; coords resolved from the summit code. */
export async function normalizeSota(raw: unknown, env: Env): Promise<Spot[]> {
  if (!Array.isArray(raw)) return [];
  const out: Spot[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    const callsign = String(pick(r, "activatorCallsign", "callsign", "activator") ?? "").toUpperCase();
    const summit = String(pick(r, "summitCode", "summit") ?? "");
    const assoc = String(pick(r, "associationCode", "association") ?? "");
    const ref = summit.includes("/") || !assoc ? summit : `${assoc}/${summit}`;
    if (!callsign || !ref) continue;
    // prefer inline coords if the feed provides them, else resolve from the summit code
    let lat = num(pick(r, "latitude", "lat")), lon = num(pick(r, "longitude", "lon"));
    let name = (pick(r, "summitName", "name") as string) || undefined;
    if (lat == null || lon == null) { const c = await sotaCoords(env, ref); if (!c) continue; lat = c.lat; lon = c.lon; name = name || c.name; }
    const freqHz = freqToHz(pick(r, "frequency", "freq") as string | number | undefined);
    out.push({
      id: `sota:${pick(r, "id") ?? `${callsign}:${ref}`}`,
      source: "sota", callsign, ref, name, lat, lon, freqHz, band: bandForHz(freqHz),
      mode: (pick(r, "mode") as string)?.toUpperCase() || undefined,
      comment: (pick(r, "comment", "comments") as string) || undefined,
      spottedAt: toUnix(pick(r, "timeStamp", "timestamp", "time", "spotTime")),
    });
  }
  return out;
}

/** Test seam: clear the cached SOTA summit coordinates. */
export function _resetSotaSummits(): void { sotaSummits.clear(); }

// ---- reception networks: "who heard whom". Mappable only with a grid/coords; a station
// without a locatable position is dropped (we don't carry a callsign→geo table). These never touch the
// A/B/C find tiers — they're a separate live-activity layer.
const recvSpot = (src: SpotSource, r: Record<string, unknown>, callKeys: string[], extra: Partial<Spot>): Spot | null => {
  const callsign = String(pick(r, ...callKeys) ?? "").toUpperCase();
  if (!callsign) return null;
  let lat = num(pick(r, "latitude", "lat")), lon = num(pick(r, "longitude", "lon"));
  if (lat == null || lon == null) { const g = gridToLatLon(pick(r, "grid", "locator", "gridsquare", "senderLocator", "dxGrid") as string); if (!g) return null; lat = g.lat; lon = g.lon; }
  const freqHz = freqToHz(pick(r, "frequency", "freq", "freqHz") as string | number | undefined);
  return {
    id: `${src}:${pick(r, "id") ?? `${callsign}:${freqHz ?? ""}`}`, source: src, callsign,
    ref: (pick(r, "ref", "grid", "locator", "senderLocator") as string) || undefined,
    lat, lon, freqHz, band: bandForHz(freqHz),
    mode: (pick(r, "mode") as string)?.toUpperCase() || undefined,
    spottedAt: toUnix(pick(r, "flowStartSeconds", "timeStamp", "time", "date", "spotTime")),
    ...extra,
  };
};

/** PSKReporter — reception reports carrying the sender's grid locator (the mappable reception source). */
export function normalizePsk(raw: unknown): Spot[] {
  const arr = Array.isArray(raw) ? raw : Array.isArray((raw as { receptionReport?: unknown[] })?.receptionReport) ? (raw as { receptionReport: unknown[] }).receptionReport : [];
  return (arr as Record<string, unknown>[])
    .map((r) => recvSpot("pskreporter", r, ["senderCallsign", "callsign", "call"], { comment: "heard via PSKReporter" }))
    .filter((s): s is Spot => s != null);
}

/** DX-cluster — spotter/dx spots; mapped only when the feed carries a grid/coords for the DX station. */
export function normalizeDxCluster(raw: unknown): Spot[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Record<string, unknown>[])
    .map((r) => recvSpot("dxcluster", r, ["dx", "spotted", "call", "callsign"], { comment: (pick(r, "comment", "info", "text") as string) || "DX spot" }))
    .filter((s): s is Spot => s != null);
}

/** RBN — skimmer reception reports; mapped only when a grid/coords is present. */
export function normalizeRbn(raw: unknown): Spot[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Record<string, unknown>[])
    .map((r) => recvSpot("rbn", r, ["dx", "call", "callsign"], { comment: (pick(r, "snr", "db") != null ? `RBN ${pick(r, "snr", "db")} dB` : "RBN spot") }))
    .filter((s): s is Spot => s != null);
}

const SOURCES: SourceDef[] = [
  { source: "pota", url: (env) => env.SPOTS_POTA_URL || "https://api.pota.app/spot/activator", normalize: normalizePota },
  { source: "sota", url: (env) => env.SPOTS_SOTA_URL || "https://api2.sota.org.uk/api/spots/50/all", normalize: normalizeSota },
  { source: "gma", url: (env) => env.SPOTS_GMA_URL || "https://www.cqgma.org/api/spots/25/", normalize: normalizeGma },
  // reception networks (mappable only with a grid/coords); enable explicitly via SPOTS_SOURCES.
  { source: "pskreporter", url: (env) => env.SPOTS_PSK_URL || "", normalize: normalizePsk },
  { source: "dxcluster", url: (env) => env.SPOTS_DXCLUSTER_URL || "", normalize: normalizeDxCluster },
  { source: "rbn", url: (env) => env.SPOTS_RBN_URL || "", normalize: normalizeRbn },
];

/** Which sources are enabled for this instance (master switch + optional allowlist). */
function enabledSources(env: Env): SourceDef[] {
  if (!truthy(env.SPOTS_ENABLED)) return [];
  const only = (env.SPOTS_SOURCES || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const chosen = only.length ? SOURCES.filter((s) => only.includes(s.source)) : SOURCES;
  return chosen.filter((s) => s.url(env)); // skip sources with no endpoint configured (e.g. reception nets)
}

let cache: { at: number; spots: Spot[] } | null = null;

async function fetchSource(def: SourceDef, env: Env): Promise<Spot[]> {
  try {
    const res = await fetch(def.url(env), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    return await def.normalize(await res.json(), env);
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
