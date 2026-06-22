import type { CacheType } from "@aprsweb/shared";

export interface TypeMeta { label: string; color: string; glyph: string }

/** Marker colour + short glyph per cache type (used on the map and in the UI). */
export const TYPE_META: Record<CacheType, TypeMeta> = {
  single:      { label: "Single",        color: "#1f9d55", glyph: "●" },
  two_stage:   { label: "Two-stage",     color: "#2b6cb0", glyph: "②" },
  multi:       { label: "Multi",         color: "#2b6cb0", glyph: "Ⓜ" },
  aprs_living: { label: "Living (APRS)",  color: "#dd6b20", glyph: "✦" },
  audio:       { label: "Audio",         color: "#805ad5", glyph: "♪" },
  traditional: { label: "Traditional",   color: "#1f9d55", glyph: "◆" },
  sota:        { label: "SOTA summit",   color: "#718096", glyph: "▲" },
  pota:        { label: "POTA park",     color: "#38a169", glyph: "❂" },
};

export const TYPE_ORDER: CacheType[] = [
  "single", "two_stage", "multi", "aprs_living", "audio", "traditional", "sota", "pota",
];

export function typeMeta(t: string): TypeMeta {
  return TYPE_META[t as CacheType] ?? { label: t, color: "#999", glyph: "●" };
}
