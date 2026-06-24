import type { CacheType } from "@aprsweb/shared";
import { BRAND } from "./brand.js";

export interface TypeMeta { label: string; color: string; glyph: string }

/** Marker colour (brand palette) + short glyph per cache type. */
export const TYPE_META: Record<CacheType, TypeMeta> = {
  single:      { label: "Single",       color: BRAND.green,  glyph: "●" },
  traditional: { label: "Traditional",  color: BRAND.green,  glyph: "◆" },
  two_stage:   { label: "Two-stage",    color: BRAND.blue,   glyph: "②" },
  multi:       { label: "Multi",        color: BRAND.blue,   glyph: "Ⓜ" },
  aprs_living: { label: "Living (APRS)", color: BRAND.blue,   glyph: "✦" },
  audio:       { label: "Audio",        color: BRAND.beige2, glyph: "♪" },
  sota:        { label: "SOTA summit",  color: BRAND.grey,   glyph: "▲" },
  pota:        { label: "POTA park",    color: BRAND.beige,  glyph: "❂" },
  wwff:        { label: "WWFF reserve", color: "#5a8a0e",    glyph: "❀" },
  bunker:      { label: "Bunker",       color: BRAND.grey,   glyph: "▣" },
  castle:      { label: "Castle",       color: BRAND.beige,  glyph: "♜" },
};

export const TYPE_ORDER: CacheType[] = [
  "single", "two_stage", "multi", "aprs_living", "audio", "traditional", "sota", "pota",
];

export function typeMeta(t: string): TypeMeta {
  return TYPE_META[t as CacheType] ?? { label: t, color: BRAND.grey, glyph: "●" };
}
