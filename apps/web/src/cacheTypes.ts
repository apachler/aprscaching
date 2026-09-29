// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CacheType } from "@aprscaching/shared";
import { BRAND } from "./brand.js";

/** `cog` = the CP437/ASCII marker glyph used when the Phosphor theme is active (no colour emoji);
 *  `help` = the one line a hider reads when picking the type. */
export interface TypeMeta {
  label: string;
  help: string;
  color: string;
  glyph: string;
  cog: string;
}

/** Marker colour (brand palette) + short glyph per cache type (`glyph` modern, `cog` = Phosphor). */
export const TYPE_META: Record<CacheType, TypeMeta> = {
  traditional: {
    label: "Traditional",
    help: "One container at the pinned spot.",
    color: BRAND.green,
    glyph: "●",
    cog: "●",
  },
  multi: {
    label: "Multi-stage",
    help: "Several stages; each one reveals where the next is.",
    color: BRAND.blue,
    glyph: "Ⓜ",
    cog: "M",
  },
  aprs_living: {
    label: "Living (APRS)",
    help: "Moves with a beaconing APRS station — found by meeting it.",
    color: BRAND.blue,
    glyph: "✦",
    cog: "*",
  },
  audio: { label: "Audio", help: "A stage unlocked by an audio clue.", color: BRAND.beige2, glyph: "♪", cog: "♪" },
  virtual: { label: "Virtual", help: "A place to visit, with no container.", color: BRAND.blue, glyph: "◇", cog: "○" },
  sota: { label: "SOTA summit", help: "A Summits on the Air summit.", color: BRAND.grey, glyph: "▲", cog: "▲" },
  pota: { label: "POTA park", help: "A Parks on the Air park.", color: BRAND.beige, glyph: "❂", cog: "♣" },
  wwff: { label: "WWFF reserve", help: "A WWFF nature reserve.", color: BRAND.greenDark, glyph: "❀", cog: "♠" },
  bunker: { label: "Bunker", help: "A bunker landmark.", color: BRAND.grey, glyph: "▣", cog: "■" },
  castle: { label: "Castle", help: "A castle landmark.", color: BRAND.beige, glyph: "♜", cog: "#" },
};

export const TYPE_ORDER: CacheType[] = ["traditional", "multi", "aprs_living", "audio", "virtual", "sota", "pota"];

export function typeMeta(t: string): TypeMeta {
  return TYPE_META[t as CacheType] ?? { label: t, help: "", color: BRAND.grey, glyph: "●", cog: "●" };
}

/** Pick the marker glyph for the active theme — Phosphor uses the CP437/ASCII `cog` variant. */
export const typeGlyph = (m: TypeMeta, phosphor: boolean): string => (phosphor ? m.cog : m.glyph);
