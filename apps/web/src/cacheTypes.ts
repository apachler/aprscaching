// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CacheType } from "@aprscaching/shared";

/** `cog` = the CP437/ASCII marker glyph used when the Phosphor theme is active (no colour emoji);
 *  `help` = the one line a hider reads when picking the type. */
export interface TypeMeta {
  label: string;
  help: string;
  glyph: string;
  cog: string;
}

/** Label, help and short glyph per cache type (`glyph` modern, `cog` = Phosphor); the colours are the
 *  `--type-*` tokens, chosen in CSS by `data-ctype`. */
export const TYPE_META: Record<CacheType, TypeMeta> = {
  traditional: {
    label: "Traditional",
    help: "One container at the pinned spot.",
    glyph: "●",
    cog: "●",
  },
  multi: {
    label: "Multi-stage",
    help: "Several stages; each one reveals where the next is.",
    glyph: "Ⓜ",
    cog: "M",
  },
  aprs_living: {
    label: "Living (APRS)",
    help: "Moves with a beaconing APRS station — found by meeting it.",
    glyph: "✦",
    cog: "*",
  },
  audio: { label: "Audio", help: "A stage unlocked by an audio clue.", glyph: "♪", cog: "♪" },
  virtual: { label: "Virtual", help: "A place to visit, with no container.", glyph: "◇", cog: "○" },
  sota: { label: "SOTA summit", help: "A Summits on the Air summit.", glyph: "▲", cog: "▲" },
  pota: { label: "POTA park", help: "A Parks on the Air park.", glyph: "❂", cog: "♣" },
  wwff: { label: "WWFF reserve", help: "A WWFF nature reserve.", glyph: "❀", cog: "♠" },
  bunker: { label: "Bunker", help: "A bunker landmark.", glyph: "▣", cog: "■" },
  castle: { label: "Castle", help: "A castle landmark.", glyph: "♜", cog: "#" },
};

/** The types the hide form offers. Heritage places come from the sysop's import, never from the form. */
export const TYPE_ORDER: CacheType[] = ["traditional", "multi", "aprs_living", "audio", "virtual"];
/** Every type a cache on the map can have, for the type filter and offline packs: imported heritage places too. */
export const FILTER_TYPES: CacheType[] = [...TYPE_ORDER, "sota", "pota", "wwff", "bunker", "castle"];

export function typeMeta(t: string): TypeMeta {
  return TYPE_META[t as CacheType] ?? { label: t, help: "", glyph: "●", cog: "●" };
}

/** Pick the marker glyph for the active theme — Phosphor uses the CP437/ASCII `cog` variant. */
export const typeGlyph = (m: TypeMeta, phosphor: boolean): string => (phosphor ? m.cog : m.glyph);
