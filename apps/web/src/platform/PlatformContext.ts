// SPDX-License-Identifier: AGPL-3.0-or-later
import { createContext, useContext } from "react";
import type * as maplibregl from "maplibre-gl";
import type { SessionState } from "../identity/useSession.js";

/** What every surface of the platform shares: the signed-in session and the live map. */
export interface PlatformValue {
  session: SessionState;
  /** The MapLibre map, or null until its container mounts. */
  map: maplibregl.Map | null;
}

export const PlatformContext = createContext<PlatformValue | null>(null);

/** The platform's session and map, plus the two session fields most surfaces read. */
export function usePlatform(): PlatformValue & { callsign: string; verified: boolean } {
  const v = useContext(PlatformContext);
  if (!v) throw new Error("usePlatform is only available inside Platform");
  return { ...v, callsign: v.session.callsign, verified: v.session.verified };
}
