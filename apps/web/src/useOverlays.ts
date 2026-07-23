// SPDX-License-Identifier: AGPL-3.0-or-later
import { useMemo, useRef, useState } from "react";

/**
 * The mutually-exclusive top-level surfaces layered over the map. The platform's invariant is that at
 * most one is open at a time ("single-overlay model" — ui-ux §5). Modelling that as one value instead
 * of a boolean per surface makes the invariant structural: opening one cannot leave another open, so
 * there is no hand-maintained close-everything list to fall out of sync.
 */
export type OverlayId =
  | "board"
  | "shack"
  | "nearby"
  | "activity"
  | "messages"
  | "profile"
  | "settings"
  | "admin"
  | "docs"
  | "signin"
  | "filter";

export interface Overlays {
  /** The open surface, or null when the bare map is showing. */
  overlay: OverlayId | null;
  /** Open exactly one surface (replaces whatever was open). */
  open: (id: OverlayId) => void;
  /** Close the open surface, back to the map. */
  close: () => void;
  /** Is this specific surface the open one. */
  is: (id: OverlayId) => boolean;
}

export function useOverlays(): Overlays {
  const [overlay, setOverlay] = useState<OverlayId | null>(null);
  // A ref mirrors the current value so the returned object can stay identity-stable across renders
  // (safe to list in a hook's deps without churning) while `overlay`/`is` still read the live state.
  const ref = useRef(overlay);
  ref.current = overlay;
  return useMemo<Overlays>(
    () => ({
      get overlay() {
        return ref.current;
      },
      open: (id) => setOverlay(id),
      close: () => setOverlay(null),
      is: (id) => ref.current === id,
    }),
    [],
  );
}
