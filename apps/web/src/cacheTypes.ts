// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CacheType } from "@aprsweb/shared";
import { BRAND } from "./brand.js";

/** `cog` = the CP437/ASCII marker glyph used when the Cogmind theme is active (no colour emoji). */
export interface TypeMeta { label: string; color: string; glyph: string; cog: string }

/** Marker colour (brand palette) + short glyph per cache type (`glyph` modern, `cog` = Cogmind). */
export const TYPE_META: Record<CacheType, TypeMeta> = {
  single:      { label: "Single",       color: BRAND.green,  glyph: "●", cog: "●" },
  traditional: { label: "Traditional",  color: BRAND.green,  glyph: "◆", cog: "◊" },
  two_stage:   { label: "Two-stage",    color: BRAND.blue,   glyph: "②", cog: "2" },
  multi:       { label: "Multi",        color: BRAND.blue,   glyph: "Ⓜ", cog: "M" },
  aprs_living: { label: "Living (APRS)", color: BRAND.blue,   glyph: "✦", cog: "*" },
  audio:       { label: "Audio",        color: BRAND.beige2, glyph: "♪", cog: "♪" },
  virtual:     { label: "Virtual",      color: BRAND.blue,   glyph: "◇", cog: "○" },
  sota:        { label: "SOTA summit",  color: BRAND.grey,   glyph: "▲", cog: "▲" },
  pota:        { label: "POTA park",    color: BRAND.beige,  glyph: "❂", cog: "♣" },
  wwff:        { label: "WWFF reserve", color: BRAND.greenDark, glyph: "❀", cog: "♠" },
  bunker:      { label: "Bunker",       color: BRAND.grey,   glyph: "▣", cog: "■" },
  castle:      { label: "Castle",       color: BRAND.beige,  glyph: "♜", cog: "#" },
};

export const TYPE_ORDER: CacheType[] = [
  "single", "two_stage", "multi", "aprs_living", "audio", "virtual", "traditional", "sota", "pota",
];

export function typeMeta(t: string): TypeMeta {
  return TYPE_META[t as CacheType] ?? { label: t, color: BRAND.grey, glyph: "●", cog: "●" };
}

/** Pick the marker glyph for the active theme — Cogmind uses the CP437/ASCII `cog` variant. */
export const typeGlyph = (m: TypeMeta, cogmind: boolean): string => (cogmind ? m.cog : m.glyph);
