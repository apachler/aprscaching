import { lookupSymbol } from "@aprsweb/aprs";

/**
 * A coarse glyph for an APRS symbol, by category (APRS101 symbol tables). Used as the map-marker
 * fallback so a heard station shows what it actually is when it carries no cache/role glyph.
 * Marker glyph precedence is: cache type → station role → APRS symbol → plain dot.
 */
const CATEGORY_GLYPH: Record<string, string> = {
  station: "📻", vehicle: "🚗", infra: "🏢", weather: "🌡", digi: "📡",
  marine: "⛵", air: "✈", event: "📍", other: "•",
};

/** Resolve a stored `symbol` ("/>" or a single char) into a display glyph + its human label. */
export function aprsGlyph(symbol: string | null | undefined): { glyph: string; label: string } | null {
  if (!symbol) return null;
  const table = symbol.length >= 2 ? symbol[0]! : "/";
  const code = symbol.length >= 2 ? symbol[1]! : symbol[0]!;
  const info = lookupSymbol(table, code);
  return { glyph: CATEGORY_GLYPH[info.category] ?? "•", label: info.label };
}
