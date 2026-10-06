// SPDX-License-Identifier: AGPL-3.0-or-later
import type { StationRole } from "@aprscaching/shared";

/**
 * `cog` = the CP437/ASCII marker glyph used when the Phosphor theme is active (no colour emoji). The pin's colour
 * comes from the stylesheet by `role` (`button.station-pin[data-role]`, a brand-palette token per role).
 */
interface RoleMeta {
  role: StationRole;
  label: string;
  glyph: string;
  cog: string;
}

/** Glyph per operated-station role — our own glyph set (ui-ux.md). */
export const ROLE_META: Record<StationRole, RoleMeta> = {
  weather: { role: "weather", label: "Weather", glyph: "☼", cog: "☼" },
  digipeater: { role: "digipeater", label: "Digipeater", glyph: "#", cog: "#" },
  igate: { role: "igate", label: "IGate", glyph: "⇅", cog: "↕" },
  node: { role: "node", label: "Node", glyph: "⬡", cog: "○" },
  repeater: { role: "repeater", label: "Repeater", glyph: "↻", cog: "→" },
};

/** Priority when a station has several roles — the most infrastructure-defining one wins the glyph. */
const ROLE_PRIORITY: StationRole[] = ["digipeater", "igate", "node", "repeater", "weather"];

/** The meta to draw for a station's role set, or null if it carries no (known) roles. */
export function roleMeta(roles: string[] | undefined): RoleMeta | null {
  if (!roles?.length) return null;
  for (const r of ROLE_PRIORITY) if (roles.includes(r)) return ROLE_META[r];
  return null;
}
