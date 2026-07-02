// SPDX-License-Identifier: MIT
/**
 * names.ts — the NAMES.GP station-type registry (docs/design/27 B.2). Graphic Packet shipped a user-editable
 * table that tagged heard callsigns by type (B> BBS, N> node, D> DX-cluster, …) and colourised them in
 * the monitor + connect lists. We reincarnate it as: a user-overridable map (callsign → type) plus a
 * conservative auto-classifier from APRS hints, and a theme-token per type so the terminal/monitor
 * colourises consistently (the Cogmind flip just remaps the tokens).
 */

/** The station types we colourise. 'user' is the default when nothing else matches. */
export type StationType =
  | "bbs" | "node" | "digi" | "dxcluster" | "weather" | "igate" | "service" | "cacher" | "beacon" | "user";

export const STATION_TYPES: StationType[] = [
  "bbs", "node", "digi", "dxcluster", "weather", "igate", "service", "cacher", "beacon", "user",
];

/** GP-style one-glyph tag shown before a call (B> N> D> …). */
export const TYPE_TAG: Record<StationType, string> = {
  bbs: "B>", node: "N>", digi: "G>", dxcluster: "D>", weather: "W>",
  igate: "I>", service: "S>", cacher: "C>", beacon: "T>", user: "·",
};

/** A CSS custom-property name for each type's colour (defined per theme in the token layer). */
export const TYPE_COLOR_VAR: Record<StationType, string> = {
  bbs: "--st-bbs", node: "--st-node", digi: "--st-digi", dxcluster: "--st-dx", weather: "--st-wx",
  igate: "--st-igate", service: "--st-service", cacher: "--st-cacher", beacon: "--st-beacon", user: "--st-user",
};

/** Hints a single heard frame gives about a station's type (all optional). */
export interface ClassifyHints {
  dest?: string;        // AX.25 dest / APRS TOCALL
  symbol?: string;      // APRS symbol, e.g. "/_" weather, "/#" digi
  payload?: string;     // information field (first chars are enough)
  ourTocalls?: string[]; // this instance's service TOCALLs (→ 'service')
}

const up = (s: string) => s.trim().toUpperCase();
/** Strip the SSID to compare base calls (OE8APR-7 → OE8APR). */
export const baseCall = (call: string): string => up(call).split("-")[0]!;
const ssidOf = (call: string): number => { const m = /-(\d+)$/.exec(up(call)); return m ? Number(m[1]) : 0; };

/** Conservative auto-classification from a heard frame. Explicit overrides (the registry) always win. */
export function classifyStation(call: string, h: ClassifyHints = {}): StationType {
  const dest = h.dest ? up(h.dest) : "";
  const sym = h.symbol ?? "";
  const pay = h.payload ?? "";

  if (h.ourTocalls?.some((t) => dest === up(t) || dest.startsWith(up(t)))) return "service";
  // APRS weather: symbol '_' or a positionless wx report, or wx fields after the position
  if (sym.endsWith("_") || /^[!=/@].*_\d{3}\/\d{3}/.test(pay) || /^_\d{8}c/.test(pay)) return "weather";
  // digipeater symbol '#'
  if (sym.endsWith("#")) return "digi";
  // NET/ROM nodes commonly beacon "...NODES..." or use the node-broadcast dest
  if (/\bNODES?\b/.test(pay) || dest === "NODES") return "node";
  // an APRS messaging/igate SSID convention: -10 = Igate, -1/-2 = wide digi (heuristic, weak)
  if (ssidOf(call) === 10) return "igate";
  // a positionful beacon with no other signal → a plain beacon/tracker
  if (/^[!=/@`'].+/.test(pay)) return "beacon";
  return "user";
}

/**
 * The registry: user overrides on top of the auto-classifier. The web layer persists `overrides`
 * (e.g. localStorage); this core is pure so it's unit-testable and reusable by the node/ingest side.
 */
export class StationRegistry {
  private overrides = new Map<string, StationType>();

  constructor(seed: Record<string, StationType> = {}) {
    for (const [k, v] of Object.entries(seed)) this.overrides.set(up(k), v);
  }
  /** Pin a callsign to a type (GP's editable NAMES table). Pass null to clear. */
  set(call: string, type: StationType | null): void {
    if (type) this.overrides.set(up(call), type); else this.overrides.delete(up(call));
  }
  get(call: string): StationType | undefined { return this.overrides.get(up(call)); }
  /** Resolve a station's type: an explicit override, else auto-classify the frame hints. */
  classify(call: string, hints?: ClassifyHints): StationType {
    return this.overrides.get(up(call)) ?? classifyStation(call, hints);
  }
  /** Export the overrides for persistence. */
  toJSON(): Record<string, StationType> {
    return Object.fromEntries(this.overrides);
  }
}
