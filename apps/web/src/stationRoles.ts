// SPDX-License-Identifier: AGPL-3.0-or-later
import type { StationRole } from "@aprsweb/shared";
import { BRAND } from "./brand.js";

/** `cog` = the CP437/ASCII marker glyph used when the Cogmind theme is active (no colour emoji). */
export interface RoleMeta {
  label: string;
  color: string;
  glyph: string;
  cog: string;
}

/** Marker colour (brand palette) + glyph per operated-station role — our own glyph set (ui-ux.md). */
export const ROLE_META: Record<StationRole, RoleMeta> = {
  weather: { label: "Weather", color: BRAND.beige2, glyph: "☼", cog: "☼" },
  digipeater: { label: "Digipeater", color: BRAND.blue, glyph: "#", cog: "#" },
  igate: { label: "IGate", color: BRAND.green, glyph: "⇅", cog: "↕" },
  node: { label: "Node", color: BRAND.grey, glyph: "⬡", cog: "○" },
  relay: { label: "Relay", color: BRAND.beige, glyph: "↻", cog: "→" },
};

/** Priority when a station has several roles — the most infrastructure-defining one wins the glyph. */
const ROLE_PRIORITY: StationRole[] = ["digipeater", "igate", "node", "relay", "weather"];

/** The meta to draw for a station's role set, or null if it carries no (known) roles. */
export function roleMeta(roles: string[] | undefined): RoleMeta | null {
  if (!roles?.length) return null;
  for (const r of ROLE_PRIORITY) if (roles.includes(r)) return ROLE_META[r];
  return null;
}
