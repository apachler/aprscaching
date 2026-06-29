import type { StationRole } from "@aprsweb/shared";
import { BRAND } from "./brand.js";

export interface RoleMeta { label: string; color: string; glyph: string }

/** Marker colour (brand palette) + glyph per operated-station role — our own glyph set (ui-ux.md). */
export const ROLE_META: Record<StationRole, RoleMeta> = {
  weather:    { label: "Weather",    color: BRAND.beige2, glyph: "☼" },
  digipeater: { label: "Digipeater", color: BRAND.blue,   glyph: "#" },
  igate:      { label: "IGate",      color: BRAND.green,  glyph: "⇅" },
  node:       { label: "Node",       color: BRAND.grey,   glyph: "⬡" },
  relay:      { label: "Relay",      color: BRAND.beige,  glyph: "↻" },
};

/** Priority when a station has several roles — the most infrastructure-defining one wins the glyph. */
const ROLE_PRIORITY: StationRole[] = ["digipeater", "igate", "node", "relay", "weather"];

/** The meta to draw for a station's role set, or null if it carries no (known) roles. */
export function roleMeta(roles: string[] | undefined): RoleMeta | null {
  if (!roles?.length) return null;
  for (const r of ROLE_PRIORITY) if (roles.includes(r)) return ROLE_META[r];
  return null;
}
