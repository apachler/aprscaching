// SPDX-License-Identifier: MIT
/**
 * ansi-export.ts — the inverse of `ansi.ts`: serialise styled terminal lines back into a
 * classic **`.ans`** artwork stream (CP437 bytes + ANSI SGR colour). Used to export the packet monitor
 * / TUI-monitor log the way a late-90s BBS would have saved it, so it opens correctly in ansilove,
 * PabloDraw, SyncTERM, etc. Pure + dependency-free (runs in Worker/Node/Bun/browser).
 */

/** A run of text with an optional 0–15 palette colour + bold — mirrors `AnsiSpan` from ansi.ts. */
export interface AnsiSeg { text: string; fg?: number; bg?: number; bold?: boolean }
/** One output row: either pre-styled segments or a plain string (drawn in the default colour). */
export type AnsiLine = AnsiSeg[] | string;

const ESC = "\x1b";
/** SGR for a segment's attributes (empty string when it's plain default text). */
function sgr(seg: AnsiSeg): string {
  const codes: number[] = [];
  if (seg.bold) codes.push(1);
  if (seg.fg != null) codes.push(seg.fg < 8 ? 30 + seg.fg : 90 + (seg.fg - 8));
  if (seg.bg != null) codes.push(seg.bg < 8 ? 40 + seg.bg : 100 + (seg.bg - 8));
  return codes.length ? `${ESC}[${codes.join(";")}m` : "";
}

/**
 * Render lines to an ANSI string: each row is reset → styled segments → CRLF (the DOS line ending
 * `.ans` expects), and the whole stream ends reset. `opts.fg` sets the default foreground (phosphor
 * green ≈ 10). Returns a JS string; pair with `cp437Bytes` for a byte-faithful download.
 */
export function toAnsi(lines: AnsiLine[], opts: { fg?: number } = {}): string {
  const reset = `${ESC}[0m`;
  const base = opts.fg != null ? `${ESC}[${opts.fg < 8 ? 30 + opts.fg : 90 + (opts.fg - 8)}m` : "";
  const out: string[] = [];
  for (const line of lines) {
    const segs: AnsiSeg[] = typeof line === "string" ? [{ text: line }] : line;
    out.push(reset + base + segs.map((s) => sgr(s) + s.text).join("") + reset);
  }
  return out.join("\r\n") + "\r\n";
}

// Unicode → CP437 for the glyphs we actually emit (box-drawing, blocks, and our marker set). ASCII
// passes through; anything unmapped degrades to '?'. This is a curated subset, not the full page.
const CP437: Record<string, number> = {
  "☺": 0x01, "♥": 0x03, "♦": 0x04, "◆": 0x04, "◊": 0x04, "♣": 0x05, "♠": 0x06,
  "•": 0x07, "●": 0x07, "○": 0x09, "♪": 0x0d, "☼": 0x0f, "►": 0x10, "◄": 0x11,
  "↕": 0x12, "↨": 0x17, "↑": 0x18, "↓": 0x19, "→": 0x1a, "←": 0x1b, "↔": 0x1d, "▲": 0x1e, "▼": 0x1f,
  "⌂": 0x7f, "°": 0xf8, "·": 0xfa, "∙": 0xf9, "√": 0xfb, "≈": 0xf7, "±": 0xf1, "≥": 0xf2, "≤": 0xf3,
  "░": 0xb0, "▒": 0xb1, "▓": 0xb2, "│": 0xb3, "┤": 0xb4, "╡": 0xb5, "╖": 0xb6, "╕": 0xb7,
  "╣": 0xb9, "║": 0xba, "╗": 0xbb, "╝": 0xbc, "┐": 0xbf,
  "└": 0xc0, "┴": 0xc1, "┬": 0xc2, "├": 0xc3, "─": 0xc4, "┼": 0xc5, "╚": 0xc8, "╔": 0xc9,
  "╩": 0xca, "╦": 0xcb, "╠": 0xcc, "═": 0xcd, "╬": 0xce, "┘": 0xd9, "┌": 0xda,
  "█": 0xdb, "▄": 0xdc, "▌": 0xdd, "▐": 0xde, "▀": 0xdf, "■": 0xfe, "▪": 0xfe,
};

/**
 * Encode an ANSI string (from `toAnsi`) to CP437 bytes. ESC/CR/LF and printable ASCII map to
 * themselves; known box-drawing/block/symbol glyphs map to their CP437 code; the rest → '?'.
 */
export function cp437Bytes(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x1b || cp === 0x0a || cp === 0x0d || (cp >= 0x20 && cp <= 0x7e)) out.push(cp);
    else if (ch in CP437) out.push(CP437[ch]!);
    else out.push(0x3f); // '?'
  }
  return new Uint8Array(out);
}
