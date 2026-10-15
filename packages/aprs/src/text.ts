// SPDX-License-Identifier: MIT
/**
 * text.ts — the human text of an info field. An AX.25 info field and an APRS-IS line carry bytes, and APRS
 * names no character set for them: the codec holds them one character per byte (ISO-8859-1), so an IGate or a
 * digipeater passes on exactly the bytes it heard. Most stations send UTF-8 today, some an 8-bit set such as
 * Latin-1; {@link rfText} turns the held bytes into the text a person reads.
 */

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * The text of an info field held one character per byte: read as UTF-8 when the bytes are valid UTF-8, else
 * kept one character per byte (Latin-1). ASCII is valid either way and returns unchanged. A string holding a
 * character above U+00FF is already text, not bytes, and returns unchanged too.
 *
 * For storing and showing what a station sent (a message, a status, a comment) only: gating to APRS-IS,
 * digipeating and duplicate checks on the air work on the bytes, never on this text.
 */
export function rfText(s: string): string {
  let high = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0xff) return s;
    if (c >= 0x80) high = true;
  }
  if (!high) return s;
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  try {
    return utf8.decode(b);
  } catch {
    return s;
  }
}

const utf8Out = new TextEncoder();

/** The UTF-8 length of one code point (a lone surrogate encodes as U+FFFD, three bytes). */
const width = (c: number): number => (c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4);

/**
 * Text this station originates (a message, a status, a comment, a beacon) as the bytes it goes out as: its UTF-8
 * encoding, held one character per byte like every info field, ready for `encodeAx25` or for an APRS-IS line
 * written one character per byte. For valid UTF-8 it is the inverse of {@link rfText}; ASCII returns unchanged.
 *
 * Only for text this station writes: a frame it relays (digipeated, or gated between RF and APRS-IS) already
 * holds the bytes it heard and passes on unchanged.
 */
export function rfBytes(text: string): string {
  if (!/[^\x00-\x7f]/.test(text)) return text;
  let out = "";
  for (const b of utf8Out.encode(text)) out += String.fromCharCode(b);
  return out;
}

/** How many bytes `text` takes on the air: the length of its UTF-8 encoding. */
export function rfByteLength(text: string): number {
  let n = 0;
  for (const ch of text) n += width(ch.codePointAt(0)!);
  return n;
}

/**
 * The longest start of `text` that takes at most `maxBytes` bytes on the air. It cuts between characters, never
 * inside one, so the bytes sent stay valid UTF-8. An APRS length limit, such as the 67 of a message's text, counts
 * these bytes.
 */
export function rfClip(text: string, maxBytes: number): string {
  let n = 0;
  let end = 0;
  for (const ch of text) {
    n += width(ch.codePointAt(0)!);
    if (n > maxBytes) break;
    end += ch.length;
  }
  return text.slice(0, end);
}
