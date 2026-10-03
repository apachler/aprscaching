// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * spots.ts — live activity-spots aggregation. Polls read-only spot
 * sources (POTA now; SOTA/WWBOTA/GMA next), normalizes to the shared `Spot` shape, dedupes across
 * sources, and serves `GET /api/spots?bbox=&bands=&modes=&sources=`.
 *
 * Cost and courtesy: aggregation is lazy + cached in-process per source, so an upstream sees one
 * request per instance rather than one per client, and nothing is persisted. Each source carries its
 * own politeness floor (`minIntervalSec`) that `SPOTS_TTL_SEC` can lengthen but never shorten — these
 * are volunteer-run APIs, and SOTA's terms make reasonable usage a condition of access. Every request
 * identifies itself with a User-Agent so an operator can see who is calling and reach us.
 * Disabled by default (SPOTS_ENABLED) so CI/offline never makes outbound calls — the pure
 * normalize/dedup/filter logic is unit-tested with fixtures instead.
 */
import { nowS } from "./util/time.js";
import { flagOn, type Env } from "./env.js";
import { jsonObjectSetting } from "./util/config.js";
import { json } from "./app.js";
import {
  type Spot,
  type SpotSource,
  bandForHz,
  freqToHz,
  gridToLatLon,
  dedupeSpots,
  filterSpots,
} from "@aprscaching/shared";

/** A normalizer turns one source's raw JSON into Spots (coords required; spots without lat/lon dropped). */
interface SourceDef {
  source: SpotSource;
  url: (env: Env) => string;
  normalize: (raw: unknown, env: Env) => Spot[] | Promise<Spot[]>;
  /** Minimum seconds between calls to this upstream. A floor: SPOTS_TTL_SEC may lengthen it, never shorten it. */
  minIntervalSec: number;
}

/** Identifies this client to upstreams; instances may override to name themselves. */
const spotsUserAgent = (env: Env) => env.SPOTS_USER_AGENT || "APRScaching (+https://github.com/apachler/aprscaching)";

const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : undefined;
};
const pick = (o: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) if (o[k] != null && o[k] !== "") return o[k];
  return undefined;
};
/**
 * Like {@link pick}, but coerces the first present value to a clean scalar string (objects/arrays →
 * undefined). Spot feeds are arbitrary third-party JSON; an unexpected non-scalar value must never
 * become an id/callsign/ref — `String({})` is "[object Object]", which would collide every such spot
 * onto one bogus identity and corrupt de-duplication.
 */
const pickStr = (o: Record<string, unknown>, ...keys: string[]): string | undefined => {
  const v = pick(o, ...keys);
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return String(v);
  return undefined;
};
const toUnix = (v: unknown): number => {
  if (typeof v === "number") return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? Math.floor(t / 1000) : nowS();
};

/** POTA — api.pota.app/spot/activator: array of activator spots carrying lat/lon. */
export function normalizePota(raw: unknown): Spot[] {
  if (!Array.isArray(raw)) return [];
  const out: Spot[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    const lat = num(pick(r, "latitude", "lat")),
      lon = num(pick(r, "longitude", "lon", "lng"));
    const callsign = (pickStr(r, "activator", "callsign", "call") ?? "").toUpperCase();
    if (lat == null || lon == null || !callsign) continue;
    const freqHz = freqToHz(pick(r, "frequency", "freq") as string | number | undefined);
    out.push({
      id: `pota:${pickStr(r, "spotId", "id") ?? `${callsign}:${pickStr(r, "reference") ?? ""}`}`,
      source: "pota",
      callsign,
      ref: pickStr(r, "reference", "ref") || undefined,
      name: pickStr(r, "name", "parkName", "locationName") || undefined,
      lat,
      lon,
      freqHz,
      band: bandForHz(freqHz),
      mode: pickStr(r, "mode")?.toUpperCase() || undefined,
      comment: pickStr(r, "comments", "comment", "text") || undefined,
      spottedAt: toUnix(pick(r, "spotTime", "timeStamp", "time", "spottedAt")),
    });
  }
  return out;
}

/** GMA / WWBOTA (cqgma.org) — `{ RCD: [...] }` (or a bare array) of spots that carry coordinates. */
export function normalizeGma(raw: unknown): Spot[] {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { RCD?: unknown[] })?.RCD)
      ? (raw as { RCD: unknown[] }).RCD
      : [];
  const out: Spot[] = [];
  for (const r of arr as Record<string, unknown>[]) {
    const lat = num(pick(r, "LAT", "latitude", "lat")),
      lon = num(pick(r, "LON", "longitude", "lon"));
    const callsign = (pickStr(r, "ACTIVATOR", "CALL", "callsign", "activator") ?? "").toUpperCase();
    if (lat == null || lon == null || !callsign) continue;
    const freqHz = freqToHz(pick(r, "QRG", "FREQUENCY", "frequency", "freq") as string | number | undefined);
    // GMA carries DATE ("2024-06-01") + TIME ("1200"/"12:00") separately
    const dateRaw = pickStr(r, "DATE", "date"),
      timeRaw = (pickStr(r, "TIME", "time") ?? "").replace(/:/g, "");
    const when = dateRaw
      ? `${dateRaw}T${timeRaw.padEnd(4, "0").slice(0, 2)}:${timeRaw.padEnd(4, "0").slice(2, 4)}:00Z`
      : pick(r, "spotTime", "timestamp");
    out.push({
      id: `gma:${pickStr(r, "ID", "id") ?? `${callsign}:${pickStr(r, "REF", "ref") ?? ""}`}`,
      source: "gma",
      callsign,
      ref: pickStr(r, "REF", "ref", "reference") || undefined,
      name: pickStr(r, "NAME", "name") || undefined,
      lat,
      lon,
      freqHz,
      band: bandForHz(freqHz),
      mode: pickStr(r, "MODE", "mode")?.toUpperCase() || undefined,
      comment: pickStr(r, "TEXT", "comment", "comments") || undefined,
      spottedAt: toUnix(when),
    });
  }
  return out;
}

// SOTA spots carry a summit code but no coordinates → resolve via the summits API. A summit found is cached
// for good (summits do not move); one not found, or a failed lookup, is remembered for the SOTA poll interval
// so the next poll does not ask again. Concurrent lookups of one code share a single request.
interface Summit {
  lat: number;
  lon: number;
  name?: string;
}
const sotaSummits = new Map<string, Summit>();
const sotaMisses = new Map<string, number>(); // code → when the miss expires (ms)
const sotaInflight = new Map<string, Promise<Summit | null>>();
/** Summit lookups in flight at once while one SOTA batch resolves. */
const SOTA_LOOKUP_CONCURRENCY = 4;

/** The summits API path for `G/LD-001`: `G/LD-001` with each part encoded (the API takes the slash as a path). */
function sotaSummitPath(code: string): string | null {
  const slash = code.indexOf("/");
  if (slash <= 0 || slash === code.length - 1) return null;
  return `${encodeURIComponent(code.slice(0, slash))}/${encodeURIComponent(code.slice(slash + 1))}`;
}

async function lookupSummit(env: Env, code: string): Promise<Summit | null> {
  const path = sotaSummitPath(code);
  if (!path) return null;
  try {
    const res = await fetch(`${SOTA_SUMMITS_URL}${path}`, {
      headers: { accept: "application/json", "user-agent": spotsUserAgent(env) },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as Record<string, unknown>;
    const lat = num(pick(d, "latitude", "lat")),
      lon = num(pick(d, "longitude", "lon"));
    if (lat == null || lon == null) return null;
    return { lat, lon, name: pickStr(d, "name", "summitName") || undefined };
  } catch {
    return null;
  }
}

async function sotaCoords(env: Env, code: string): Promise<Summit | null> {
  const hit = sotaSummits.get(code);
  if (hit) return hit;
  const nowMs = Date.now();
  const missUntil = sotaMisses.get(code);
  if (missUntil != null && missUntil > nowMs) return null;
  let pending = sotaInflight.get(code);
  if (!pending) {
    pending = lookupSummit(env, code)
      .then((v) => {
        if (v) {
          sotaSummits.set(code, v);
          sotaMisses.delete(code);
        } else sotaMisses.set(code, Date.now() + intervalSec(SOTA_SOURCE, env) * 1000);
        return v;
      })
      .finally(() => sotaInflight.delete(code));
    sotaInflight.set(code, pending);
  }
  return pending;
}

/** Run `fn` over `items` with at most `limit` calls in flight. */
async function mapBounded<T>(items: T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const sotaRef = (r: Record<string, unknown>): string => {
  const summit = pickStr(r, "summitCode", "summit") ?? "";
  const assoc = pickStr(r, "associationCode", "association") ?? "";
  return summit.includes("/") || !assoc ? summit : `${assoc}/${summit}`;
};
const hasCoords = (r: Record<string, unknown>): boolean =>
  num(pick(r, "latitude", "lat")) != null && num(pick(r, "longitude", "lon")) != null;

/** SOTA — api2.sota.org.uk/api/spots: array; coords resolved from the summit code. */
export async function normalizeSota(raw: unknown, env: Env): Promise<Spot[]> {
  if (!Array.isArray(raw)) return [];
  const rows = raw as Record<string, unknown>[];
  // resolve every summit the batch needs first, a few at a time, so one slow lookup does not hold up the rest
  const needed = new Set<string>();
  for (const r of rows) {
    const ref = sotaRef(r);
    if (ref && !hasCoords(r)) needed.add(ref);
  }
  const resolved = new Map<string, Summit | null>();
  await mapBounded([...needed], SOTA_LOOKUP_CONCURRENCY, async (ref) => resolved.set(ref, await sotaCoords(env, ref)));
  const out: Spot[] = [];
  for (const r of rows) {
    const callsign = (pickStr(r, "activatorCallsign", "callsign", "activator") ?? "").toUpperCase();
    const ref = sotaRef(r);
    if (!callsign || !ref) continue;
    // prefer inline coords if the feed provides them, else the summit lookup
    let lat = num(pick(r, "latitude", "lat")),
      lon = num(pick(r, "longitude", "lon"));
    let name = pickStr(r, "summitName", "name") || undefined;
    if (lat == null || lon == null) {
      const c = resolved.get(ref);
      if (!c) continue;
      lat = c.lat;
      lon = c.lon;
      name = name || c.name;
    }
    const freqHz = freqToHz(pick(r, "frequency", "freq") as string | number | undefined);
    out.push({
      id: `sota:${pickStr(r, "id") ?? `${callsign}:${ref}`}`,
      source: "sota",
      callsign,
      ref,
      name,
      lat,
      lon,
      freqHz,
      band: bandForHz(freqHz),
      mode: pickStr(r, "mode")?.toUpperCase() || undefined,
      comment: pickStr(r, "comment", "comments") || undefined,
      spottedAt: toUnix(pick(r, "timeStamp", "timestamp", "time", "spotTime")),
    });
  }
  return out;
}

/** Test seam: clear the cached SOTA summit coordinates. */
export function _resetSotaSummits(): void {
  sotaSummits.clear();
  sotaMisses.clear();
  sotaInflight.clear();
}

// ---- reception networks: "who heard whom". Mappable only with a grid/coords; a station
// without a locatable position is dropped (we don't carry a callsign→geo table). These never touch the
// A/B/C find tiers — they're a separate live-activity layer.
const recvSpot = (
  src: SpotSource,
  r: Record<string, unknown>,
  callKeys: string[],
  extra: Partial<Spot>,
): Spot | null => {
  const callsign = (pickStr(r, ...callKeys) ?? "").toUpperCase();
  if (!callsign) return null;
  let lat = num(pick(r, "latitude", "lat")),
    lon = num(pick(r, "longitude", "lon"));
  if (lat == null || lon == null) {
    const g = gridToLatLon(pickStr(r, "grid", "locator", "gridsquare", "senderLocator", "dxGrid"));
    if (!g) return null;
    lat = g.lat;
    lon = g.lon;
  }
  const freqHz = freqToHz(pick(r, "frequency", "freq", "freqHz") as string | number | undefined);
  return {
    id: `${src}:${pickStr(r, "id") ?? `${callsign}:${freqHz ?? ""}`}`,
    source: src,
    callsign,
    ref: pickStr(r, "ref", "grid", "locator", "senderLocator") || undefined,
    lat,
    lon,
    freqHz,
    band: bandForHz(freqHz),
    mode: pickStr(r, "mode")?.toUpperCase() || undefined,
    spottedAt: toUnix(pick(r, "flowStartSeconds", "timeStamp", "time", "date", "spotTime")),
    ...extra,
  };
};

/** PSKReporter — reception reports carrying the sender's grid locator (the mappable reception source). */
export function normalizePsk(raw: unknown): Spot[] {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { receptionReport?: unknown[] })?.receptionReport)
      ? (raw as { receptionReport: unknown[] }).receptionReport
      : [];
  return (arr as Record<string, unknown>[])
    .map((r) =>
      recvSpot("pskreporter", r, ["senderCallsign", "callsign", "call"], { comment: "heard via PSKReporter" }),
    )
    .filter((s): s is Spot => s != null);
}

/** DX-cluster — spotter/dx spots; mapped only when the feed carries a grid/coords for the DX station. */
export function normalizeDxCluster(raw: unknown): Spot[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Record<string, unknown>[])
    .map((r) =>
      recvSpot("dxcluster", r, ["dx", "spotted", "call", "callsign"], {
        comment: pickStr(r, "comment", "info", "text") || "DX spot",
      }),
    )
    .filter((s): s is Spot => s != null);
}

/** RBN — skimmer reception reports; mapped only when a grid/coords is present. */
export function normalizeRbn(raw: unknown): Spot[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Record<string, unknown>[])
    .map((r) =>
      recvSpot("rbn", r, ["dx", "call", "callsign"], {
        comment: pick(r, "snr", "db") != null ? `RBN ${pickStr(r, "snr", "db") ?? ""} dB` : "RBN spot",
      }),
    )
    .filter((s): s is Spot => s != null);
}

/** SOTA summit details, for resolving a spot's summit code to coordinates. */
const SOTA_SUMMITS_URL = "https://api-db2.sota.org.uk/api/summits/";

/**
 * The reception networks have no single public JSON feed to build in, so each is polled only at an
 * endpoint the operator names: `SPOTS_RECEPTION_URLS={"pskreporter":"…","dxcluster":"…","rbn":"…"}`.
 */
const receptionUrl = (env: Env, source: SpotSource): string => {
  const v = jsonObjectSetting(env.SPOTS_RECEPTION_URLS)[source];
  return typeof v === "string" ? v : "";
};

const SOTA_SOURCE: SourceDef = {
  source: "sota",
  url: () => "https://api2.sota.org.uk/api/spots/50/all",
  normalize: normalizeSota,
  minIntervalSec: 180, // SOTA asks for reasonable use and blocks heavy clients; stay well inside it
};

const SOURCES: SourceDef[] = [
  {
    source: "pota",
    url: () => "https://api.pota.app/spot/activator",
    normalize: normalizePota,
    minIntervalSec: 120,
  },
  SOTA_SOURCE,
  {
    source: "gma",
    url: () => "https://www.cqgma.org/api/spots/25/",
    normalize: normalizeGma,
    minIntervalSec: 120,
  },
  // reception networks (mappable only with a grid/coords), polled only at a configured endpoint
  {
    source: "pskreporter",
    url: (env) => receptionUrl(env, "pskreporter"),
    normalize: normalizePsk,
    minIntervalSec: 300,
  },
  {
    source: "dxcluster",
    url: (env) => receptionUrl(env, "dxcluster"),
    normalize: normalizeDxCluster,
    minIntervalSec: 120,
  },
  { source: "rbn", url: (env) => receptionUrl(env, "rbn"), normalize: normalizeRbn, minIntervalSec: 120 },
];

/** Which sources are enabled for this instance (master switch + optional allowlist). */
function enabledSources(env: Env): SourceDef[] {
  if (!flagOn(env.SPOTS_ENABLED)) return [];
  const only = (env.SPOTS_SOURCES || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const chosen = only.length ? SOURCES.filter((s) => only.includes(s.source)) : SOURCES;
  return chosen.filter((s) => s.url(env)); // skip sources with no endpoint configured (e.g. reception nets)
}

const cache = new Map<SpotSource, { at: number; spots: Spot[] }>();
/** The upstream fetch under way per source: requests arriving while it runs wait for it rather than call again. */
const inflight = new Map<SpotSource, Promise<Spot[]>>();

async function fetchSource(def: SourceDef, env: Env): Promise<Spot[]> {
  try {
    const res = await fetch(def.url(env), {
      headers: { accept: "application/json", "user-agent": spotsUserAgent(env) },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    return await def.normalize(await res.json(), env);
  } catch {
    return [];
  } // a down source must never break the others
}

/** Seconds between calls to one upstream: its own floor, or the instance setting when that is longer. */
function intervalSec(def: SourceDef, env: Env): number {
  return Math.max(Number(env.SPOTS_TTL_SEC) || 120, def.minIntervalSec);
}

/** Aggregate (lazy, per-source cached, deduped). Returns [] when spots are disabled. */
export async function getSpots(env: Env): Promise<Spot[]> {
  const sources = enabledSources(env);
  if (!sources.length) return [];
  const nowMs = Date.now();
  const batches = await Promise.all(
    sources.map(async (def) => {
      const hit = cache.get(def.source);
      if (hit && nowMs - hit.at < intervalSec(def, env) * 1000) return hit.spots;
      let pending = inflight.get(def.source);
      if (!pending) {
        pending = fetchSource(def, env)
          .then((spots) => {
            cache.set(def.source, { at: nowMs, spots });
            return spots;
          })
          .finally(() => inflight.delete(def.source));
        inflight.set(def.source, pending);
      }
      return pending;
    }),
  );
  return dedupeSpots(batches.flat());
}

/** When the oldest still-served source was last fetched — the age the client should believe. */
function oldestFetchAt(env: Env): number | null {
  const times = enabledSources(env)
    .map((def) => cache.get(def.source)?.at)
    .filter((at): at is number => at != null);
  return times.length ? Math.min(...times) : null;
}

/** Test seam: reset the in-process cache. */
export function _resetSpotsCache(): void {
  cache.clear();
  inflight.clear();
}

const csv = (v: string | null) =>
  v
    ? v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

/** GET /api/spots?bbox=minLon,minLat,maxLon,maxLat&bands=20m,2m&modes=SSB&sources=pota */
export async function handleSpots(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const enabled = flagOn(env.SPOTS_ENABLED);
  const bboxRaw = csv(u.searchParams.get("bbox"))?.map(Number);
  const bbox =
    bboxRaw && bboxRaw.length === 4 && bboxRaw.every(Number.isFinite)
      ? (bboxRaw as [number, number, number, number])
      : undefined;
  const all = await getSpots(env);
  const spots = filterSpots(all, {
    bbox,
    bands: csv(u.searchParams.get("bands")),
    modes: csv(u.searchParams.get("modes")),
    sources: csv(u.searchParams.get("sources")),
  });
  const at = oldestFetchAt(env);
  return json({ enabled, count: spots.length, fetchedAt: at ? Math.floor(at / 1000) : null, spots });
}
