// SPDX-License-Identifier: AGPL-3.0-or-later
import { useTheme } from "../format.js";

/**
 * A decorative glyph that is emoji in Modern and ASCII/CP437 in Phosphor (which is strictly emoji-free —
 *). `e` = the Modern glyph (include any trailing space, e.g. "📻 "); `c` = the Phosphor
 * replacement (default "" → dropped entirely, letting the box-drawing frame / adjacent label carry the
 * meaning). Rendered aria-hidden: these are decorative, the adjacent text is the accessible name.
 */
export function Ico({ e, c = "" }: { e: string; c?: string }) {
  const g = useTheme() === "phosphor" ? c : e;
  return g ? (
    <span className="ico" aria-hidden="true">
      {g}
    </span>
  ) : null;
}
