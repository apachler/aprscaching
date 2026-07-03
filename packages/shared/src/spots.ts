// SPDX-License-Identifier: MIT
/**
 * spots.ts — the live activity-spots contract. A Spot is a normalized "who is on the air
 * right now, where" record aggregated read-only from POTA/SOTA/WWBOTA/GMA (and later DX-cluster/RBN/
 * PSKReporter). Pure + dependency-free so the gateway, the web map, and tooling all share one shape.
 *
 * Spots are ephemeral and NEVER touch the A/B/C find tiers.
 */

export type SpotSource = "pota" | "sota" | "wwbota" | "gma" | "dxcluster" | "rbn" | "pskreporter";

export interface Spot {
  /** stable dedup id (source-independent: a single activation spotted by many sources collapses to one) */
  id: string;
  source: SpotSource;
  callsign: string;
  /** program reference, e.g. "US-0001" (POTA) or "OE/ST-027" (SOTA) */
  ref?: string;
  /** park/summit name */
  name?: string;
  lat: number;
  lon: number;
  /** dial frequency in Hz */
  freqHz?: number;
  /** SSB / CW / FM / DATA / FT8 … (source spelling, upper-cased) */
  mode?: string;
  /** derived ham band label, e.g. "20m", "2m" (from freqHz) */
  band?: string;
  comment?: string;
  /** unix seconds when spotted */
  spottedAt: number;
}

/** Amateur band plan (Hz ranges → label). Coarse but covers HF→23cm for spot labelling. */
const BANDS: ReadonlyArray<[number, number, string]> = [
  [135_700, 137_800, "2200m"],
  [472_000, 479_000, "630m"],
  [1_800_000, 2_000_000, "160m"],
  [3_500_000, 4_000_000, "80m"],
  [5_250_000, 5_450_000, "60m"],
  [7_000_000, 7_300_000, "40m"],
  [10_100_000, 10_150_000, "30m"],
  [14_000_000, 14_350_000, "20m"],
  [18_068_000, 18_168_000, "17m"],
  [21_000_000, 21_450_000, "15m"],
  [24_890_000, 24_990_000, "12m"],
  [28_000_000, 29_700_000, "10m"],
  [50_000_000, 54_000_000, "6m"],
  [70_000_000, 70_500_000, "4m"],
  [144_000_000, 148_000_000, "2m"],
  [222_000_000, 225_000_000, "1.25m"],
  [420_000_000, 450_000_000, "70cm"],
  [902_000_000, 928_000_000, "33cm"],
  [1_240_000_000, 1_300_000_000, "23cm"],
];

// Maidenhead pair bases: field 18 · square 10 · subsquare 24 · ext-square 10 · ext-subsquare 24 (F-7).
const MH_BASES = [18, 10, 24, 10, 24];
/**
 * Maidenhead grid locator → lat/lon (centre of the smallest cell). Accepts 4/6/8/10-char grids — the
 * canonical parser shared by the gateway (profile locator validation), spots and tools, so the 10-char
 * locator (F-7) is honoured everywhere, not just in the web `gridCenter`.
 */
export function gridToLatLon(grid: string | undefined | null): { lat: number; lon: number } | null {
  const g = String(grid ?? "")
    .trim()
    .toUpperCase();
  if (!/^[A-R]{2}[0-9]{2}([A-X]{2}([0-9]{2}([A-X]{2})?)?)?$/.test(g)) return null;
  const pairs = g.match(/../g)!;
  let lon = -180,
    lat = -90,
    lonCell = 360,
    latCell = 180;
  for (let p = 0; p < pairs.length; p++) {
    lonCell /= MH_BASES[p]!;
    latCell /= MH_BASES[p]!;
    const base = p === 0 || p % 2 === 0 ? 65 : 48; // letters A-X (field/subsquare) or digits 0-9
    lon += (pairs[p]!.charCodeAt(0) - base) * lonCell;
    lat += (pairs[p]!.charCodeAt(1) - base) * latCell;
  }
  return { lat: lat + latCell / 2, lon: lon + lonCell / 2 }; // centre of the smallest cell
}

/** Band label for a dial frequency in Hz (undefined if outside the plan or absent). */
export function bandForHz(hz?: number): string | undefined {
  if (!hz || !Number.isFinite(hz)) return undefined;
  for (const [lo, hi, label] of BANDS) if (hz >= lo && hz <= hi) return label;
  return undefined;
}

/** Parse a source frequency that may be in kHz or MHz (string/number) into Hz. */
export function freqToHz(value: string | number | undefined | null): number | undefined {
  if (value == null || value === "") return undefined;
  const n = typeof value === "number" ? value : parseFloat(String(value).replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  // Heuristic: POTA/SOTA spot frequencies are kHz (e.g. 14250) or MHz (e.g. 14.250). Disambiguate by size.
  if (n < 1000) return Math.round(n * 1_000_000); // MHz
  if (n < 1_000_000) return Math.round(n * 1_000); // kHz
  return Math.round(n); // already Hz
}

/** Dedup key: one activation = one callsign at one reference on one band, newest wins. */
export function spotKey(s: Pick<Spot, "callsign" | "ref" | "band" | "freqHz">): string {
  return `${s.callsign.toUpperCase()}|${(s.ref ?? "").toUpperCase()}|${s.band ?? s.freqHz ?? ""}`;
}

/** Merge spots across sources: keep the most recently-spotted record per activation. */
export function dedupeSpots(spots: Spot[]): Spot[] {
  const best = new Map<string, Spot>();
  for (const s of spots) {
    const k = spotKey(s);
    const cur = best.get(k);
    if (!cur || s.spottedAt > cur.spottedAt) best.set(k, s);
  }
  return [...best.values()].sort((a, b) => b.spottedAt - a.spottedAt);
}

/** Filter spots by an optional bbox [minLon,minLat,maxLon,maxLat] + band/mode/source sets. */
export function filterSpots(
  spots: Spot[],
  opts: { bbox?: [number, number, number, number]; bands?: string[]; modes?: string[]; sources?: string[] },
): Spot[] {
  const bands = opts.bands?.length ? new Set(opts.bands.map((b) => b.toLowerCase())) : null;
  const modes = opts.modes?.length ? new Set(opts.modes.map((m) => m.toUpperCase())) : null;
  const sources = opts.sources?.length ? new Set(opts.sources.map((s) => s.toLowerCase())) : null;
  return spots.filter((s) => {
    if (opts.bbox) {
      const [minLon, minLat, maxLon, maxLat] = opts.bbox;
      if (s.lon < minLon || s.lon > maxLon || s.lat < minLat || s.lat > maxLat) return false;
    }
    if (bands && !(s.band && bands.has(s.band.toLowerCase()))) return false;
    if (modes && !(s.mode && modes.has(s.mode.toUpperCase()))) return false;
    if (sources && !sources.has(s.source)) return false;
    return true;
  });
}
