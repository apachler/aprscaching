import { useTheme } from "../format.js";

/**
 * A decorative glyph that is emoji in Modern and ASCII/CP437 in Cogmind (which is strictly emoji-free —
 * docs/24). `e` = the Modern glyph (include any trailing space, e.g. "📻 "); `c` = the Cogmind
 * replacement (default "" → dropped entirely, letting the box-drawing frame / adjacent label carry the
 * meaning). Rendered aria-hidden: these are decorative, the adjacent text is the accessible name.
 */
export function Ico({ e, c = "" }: { e: string; c?: string }) {
  const g = useTheme() === "cogmind" ? c : e;
  return g ? <span className="ico" aria-hidden="true">{g}</span> : null;
}
