// SPDX-License-Identifier: MIT
/**
 * symbols.ts — APRS symbol catalog (APRS101 §appendix "Symbol Tables").
 * A symbol is a (table, code) pair: table '/' = primary, '\' = alternate, or a digit/letter
 * for an overlay. We map the common symbols to a human label + a coarse category used by the
 * shack/map. Unknown symbols fall back to a generic label but still carry table/code.
 */
export interface SymbolInfo {
  table: string; // '/', '\', or overlay char
  code: string; // the symbol code character
  label: string; // human-readable
  category: string; // station | vehicle | infra | weather | digi | marine | air | event | other
  overlay?: string; // overlay character when table is not '/' or '\'
}

// keyed by code char; primary ('/') and alternate ('\') get distinct entries where they differ
const PRIMARY: Record<string, [string, string]> = {
  "!": ["Police/Sheriff", "infra"],
  "#": ["Digipeater", "digi"],
  $: ["Phone", "infra"],
  "%": ["DX cluster", "infra"],
  "&": ["HF gateway", "digi"],
  "'": ["Small aircraft", "air"],
  "(": ["Mobile satellite station", "infra"],
  ")": ["Wheelchair", "vehicle"],
  "*": ["Snowmobile", "vehicle"],
  "+": ["Red Cross", "infra"],
  ",": ["Boy Scouts", "event"],
  "-": ["House (HF)", "station"],
  ".": ["X (unknown)", "other"],
  "/": ["Red dot", "other"],
  "0": ["Circle (number)", "other"],
  "<": ["Motorcycle", "vehicle"],
  "=": ["Railroad engine", "vehicle"],
  ">": ["Car", "vehicle"],
  A: ["Aid station", "infra"],
  B: ["BBS", "infra"],
  C: ["Canoe", "marine"],
  E: ["Eyeball (event)", "event"],
  F: ["Farm vehicle/tractor", "vehicle"],
  I: ["TCP/IP", "infra"],
  K: ["School", "infra"],
  O: ["Balloon", "air"],
  P: ["Police", "infra"],
  R: ["Recreational vehicle", "vehicle"],
  U: ["Bus", "vehicle"],
  V: ["ATV", "vehicle"],
  W: ["National weather service", "weather"],
  X: ["Helicopter", "air"],
  Y: ["Yacht/sailboat", "marine"],
  "[": ["Jogger", "station"],
  "^": ["Large aircraft", "air"],
  _: ["Weather station", "weather"],
  a: ["Ambulance", "vehicle"],
  b: ["Bicycle", "vehicle"],
  f: ["Fire truck", "vehicle"],
  g: ["Glider", "air"],
  h: ["Hospital", "infra"],
  j: ["Jeep", "vehicle"],
  k: ["Truck", "vehicle"],
  l: ["Laptop", "station"],
  m: ["Mic-E repeater", "digi"],
  n: ["Node", "infra"],
  o: ["EOC", "infra"],
  p: ["Dog/rover", "station"],
  r: ["Antenna/repeater", "digi"],
  s: ["Ship/power boat", "marine"],
  t: ["Truck stop", "infra"],
  u: ["Truck (18-wheeler)", "vehicle"],
  v: ["Van", "vehicle"],
  y: ["Yagi at QTH", "station"],
  "<>": ["", ""],
};
const ALTERNATE: Record<string, [string, string]> = {
  "!": ["Emergency", "event"],
  "#": ["Overlay digipeater", "digi"],
  "&": ["Overlay gateway", "digi"],
  "(": ["Cloudy", "weather"],
  "*": ["Snow", "weather"],
  "<": ["Gale/storm", "weather"],
  ">": ["Overlay car", "vehicle"],
  A: ["Overlay box", "other"],
  O: ["Rocket", "air"],
  W: ["Flooding", "weather"],
  _: ["Weather (alt)", "weather"],
  n: ["Overlay triangle", "other"],
  s: ["Overlay ship", "marine"],
  u: ["Overlay truck", "vehicle"],
};

export function lookupSymbol(table: string, code: string): SymbolInfo {
  const isPrimary = table === "/";
  const isAlt = table === "\\";
  const overlay = !isPrimary && !isAlt ? table : undefined;
  const map = isPrimary ? PRIMARY : ALTERNATE; // overlays use the alternate table glyphs
  const hit = map[code];
  if (hit && hit[0]) return { table, code, label: hit[0], category: hit[1], overlay };
  return { table, code, label: `Symbol ${table}${code}`, category: "other", overlay };
}

/**
 * The symbol code each `GPSxyz` leading letter starts at (APRS 1.2 Appendix 2), and the range of the second
 * character that counts on from it. The primary table's letters are B, P, M, H, L, J; the alternate table's
 * O, A, N, D, S, Q in the same places.
 */
const XY_BLOCKS: { primary: string; alternate: string; from: string; to: string; code: string }[] = [
  { primary: "B", alternate: "O", from: "B", to: "P", code: "!" },
  { primary: "P", alternate: "A", from: "0", to: "9", code: "0" },
  { primary: "M", alternate: "N", from: "R", to: "X", code: ":" },
  { primary: "P", alternate: "A", from: "A", to: "Z", code: "A" },
  { primary: "H", alternate: "D", from: "S", to: "X", code: "[" },
  { primary: "L", alternate: "S", from: "A", to: "Z", code: "a" },
  { primary: "J", alternate: "Q", from: "1", to: "4", code: "{" },
];

/** The primary-table symbol each source SSID `-1` to `-15` stands for (index 0, no SSID, stands for none). */
const SSID_SYMBOLS = " aUfbYX's><OjRkv";

/**
 * The symbol a packet without one in its information field takes from its addresses (APRS 1.2 chapter 21):
 * the destination's `GPSxyz`, `SPCxyz` or `SYMxyz` (xy names the symbol, z an overlay or a space), or its
 * `GPSCnn` (primary) or `GPSEnn` (alternate) with nn 01–94; failing that, a non-zero source SSID
 * (`-9` a car). Undefined when neither names one.
 */
export function symbolFromAddress(dst: string, src: string): SymbolInfo | undefined {
  const call = dst.split("-")[0]!.toUpperCase();
  const cnn = /^GPS([CE])(\d{2})$/.exec(call);
  if (cnn) {
    const n = Number(cnn[2]);
    if (n >= 1 && n <= 94) return lookupSymbol(cnn[1] === "C" ? "/" : "\\", String.fromCharCode(32 + n));
  }
  const xyz = /^(?:GPS|SPC|SYM)([A-Z])([A-Z0-9])([A-Z0-9 ]?)$/.exec(call);
  if (xyz) {
    const x = xyz[1]!,
      y = xyz[2]!,
      z = xyz[3]!.trim();
    for (const b of XY_BLOCKS) {
      const alternate = x === b.alternate;
      if ((x !== b.primary && !alternate) || y < b.from || y > b.to) continue;
      const code = String.fromCharCode(b.code.charCodeAt(0) + y.charCodeAt(0) - b.from.charCodeAt(0));
      // an overlay goes on an alternate-table symbol only
      return lookupSymbol(alternate ? z || "\\" : "/", code);
    }
  }
  const ssid = Number(src.split("-")[1] ?? 0);
  return Number.isInteger(ssid) && ssid >= 1 && ssid <= 15 ? lookupSymbol("/", SSID_SYMBOLS[ssid]!) : undefined;
}
