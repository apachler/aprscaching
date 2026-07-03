// SPDX-License-Identifier: MIT
/**
 * symbols.ts — APRS symbol catalog (APRS101 §appendix "Symbol Tables").
 * A symbol is a (table, code) pair: table '/' = primary, '\' = alternate, or a digit/letter
 * for an overlay. We map the common symbols to a human label + a coarse category used by the
 * workbench/map. Unknown symbols fall back to a generic label but still carry table/code.
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
