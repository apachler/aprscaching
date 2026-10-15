// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Removing the metadata a photo carries before the instance stores it. A camera or a phone writes Exif (often the
 * GPS position the photo was taken at, which may be the uploader's home), XMP and IPTC into the file. The web app
 * re-encodes every photo through a canvas, which writes none of them; this filter holds the same line for a client
 * that uploads the file as the camera wrote it.
 *
 * Each format is walked at the container level, byte by byte, and only what draws the picture is kept: the pixels,
 * their colour profile, transparency and animation. Nothing is decoded or re-encoded, so the pixels are exactly
 * the uploaded ones. A file that does not parse as the type it was sent as yields null, and the caller refuses it:
 * a file this filter cannot walk is a file it cannot vouch for.
 *
 * A JPEG's Exif also holds its orientation, so a photo from a client that leaves the rotation to that tag is
 * stored as the sensor recorded it; the web app turns the pixels upright before upload.
 */

const ascii = (b: Uint8Array, at: number, text: string): boolean => {
  if (at + text.length > b.length) return false;
  for (let i = 0; i < text.length; i++) if (b[at + i] !== text.charCodeAt(i)) return false;
  return true;
};
const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u32be = (b: Uint8Array, at: number) =>
  ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!;
const u32le = (b: Uint8Array, at: number) =>
  ((b[at + 3]! << 24) >>> 0) + (b[at + 2]! << 16) + (b[at + 1]! << 8) + b[at]!;

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * The image with its metadata removed, or null when the bytes are not a well-formed image of `contentType`. A
 * type this filter does not know comes back unchanged.
 */
export function stripImageMetadata(bytes: Uint8Array, contentType: string): Uint8Array | null {
  try {
    switch (contentType) {
      case "image/jpeg":
        return stripJpeg(bytes);
      case "image/png":
        return stripPng(bytes);
      case "image/webp":
        return stripWebp(bytes);
      case "image/gif":
        return stripGif(bytes);
      case "image/avif":
        return blankAvifMetadata(bytes);
      default:
        return bytes;
    }
  } catch {
    return null;
  }
}

// ---- JPEG: a run of marker segments, the entropy-coded scans between them, and EOI ----

/**
 * The application segments a JPEG keeps: the JFIF header, the ICC colour profile and Adobe's colour-transform
 * flag, which a decoder needs to read CMYK and YCCK files right. Every other APPn (Exif and XMP in APP1, the
 * multi-picture index in APP2, IPTC in APP13) and every comment is dropped.
 */
function keepJpegSegment(b: Uint8Array, marker: number, body: number): boolean {
  if (marker === 0xfe) return false; // COM
  if (marker < 0xe0 || marker > 0xef) return true; // tables, frame and scan headers, restart interval
  if (marker === 0xe0) return ascii(b, body, "JFIF\0");
  if (marker === 0xe2) return ascii(b, body, "ICC_PROFILE\0");
  if (marker === 0xee) return ascii(b, body, "Adobe");
  return false;
}

function stripJpeg(b: Uint8Array): Uint8Array | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let pos = 2;
  for (;;) {
    if (pos >= b.length || b[pos] !== 0xff) return null;
    while (b[pos] === 0xff) pos++; // fill bytes before a marker
    if (pos >= b.length) return null;
    const marker = b[pos]!;
    pos++;
    if (marker === 0xd9) {
      // EOI: anything a phone appends after it (a second picture, a video, a vendor trailer) is dropped
      parts.push(new Uint8Array([0xff, 0xd9]));
      return concat(parts);
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push(new Uint8Array([0xff, marker]));
      continue;
    }
    if (marker === 0x00 || marker === 0xd8 || pos + 2 > b.length) return null;
    const len = u16be(b, pos);
    const end = pos + len;
    if (len < 2 || end > b.length) return null;
    if (keepJpegSegment(b, marker, pos + 2)) parts.push(b.subarray(pos - 2, end));
    pos = end;
    if (marker === 0xda) {
      // the scan's entropy-coded data runs to the next marker that is neither a stuffed 0x00 nor a restart
      let i = pos;
      for (;;) {
        if (i + 1 >= b.length) return null;
        if (b[i] === 0xff) {
          const next = b[i + 1]!;
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7)) break;
          i += 2;
        } else i++;
      }
      parts.push(b.subarray(pos, i));
      pos = i;
    }
  }
}

// ---- PNG: a signature, then length · type · data · CRC chunks up to IEND ----

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_CRITICAL = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);
/**
 * The ancillary chunks that change how the picture draws: transparency, colour and gamma, pixel size, and the
 * APNG animation. Text (tEXt, zTXt, iTXt, where XMP lives), eXIf, the timestamp and any private chunk are dropped.
 */
const PNG_KEEP = new Set([
  "tRNS",
  "gAMA",
  "cHRM",
  "sRGB",
  "iCCP",
  "cICP",
  "mDCV",
  "cLLI",
  "sBIT",
  "bKGD",
  "pHYs",
  "acTL",
  "fcTL",
  "fdAT",
]);

function stripPng(b: Uint8Array): Uint8Array | null {
  if (b.length < 8 || PNG_SIGNATURE.some((v, i) => b[i] !== v)) return null;
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let pos = 8;
  for (;;) {
    if (pos + 12 > b.length) return null;
    const len = u32be(b, pos);
    const end = pos + 12 + len;
    if (end > b.length) return null;
    const type = String.fromCharCode(b[pos + 4]!, b[pos + 5]!, b[pos + 6]!, b[pos + 7]!);
    if (pos === 8 && type !== "IHDR") return null;
    const critical = (b[pos + 4]! & 0x20) === 0;
    // a decoder refuses a critical chunk it does not know, so such a file is not a picture anyone sees
    if (critical && !PNG_CRITICAL.has(type)) return null;
    if (critical || PNG_KEEP.has(type)) parts.push(b.subarray(pos, end));
    pos = end;
    if (type === "IEND") return concat(parts);
  }
}

// ---- WebP: a RIFF container of fourcc · little-endian size · data chunks, each padded to an even length ----

/** The chunks that draw a WebP: the bitstreams, the extended header, alpha, animation and the colour profile. */
const WEBP_KEEP = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF", "ICCP"]);
/** The VP8X header's flags naming an Exif and an XMP chunk, cleared once those chunks are gone. */
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

function stripWebp(b: Uint8Array): Uint8Array | null {
  if (b.length < 20 || !ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) return null;
  const limit = Math.min(b.length, 8 + u32le(b, 4));
  const parts: Uint8Array[] = [];
  let pos = 12;
  while (pos + 8 <= limit) {
    const fourcc = String.fromCharCode(b[pos]!, b[pos + 1]!, b[pos + 2]!, b[pos + 3]!);
    const size = u32le(b, pos + 4);
    const end = pos + 8 + size + (size & 1);
    if (pos + 8 + size > limit) return null;
    if (pos === 12 && fourcc !== "VP8 " && fourcc !== "VP8L" && fourcc !== "VP8X") return null;
    if (WEBP_KEEP.has(fourcc)) {
      const chunk = new Uint8Array(end - pos); // the pad byte is zero even where the file left it off
      chunk.set(b.subarray(pos, Math.min(end, limit)));
      if (fourcc === "VP8X" && size >= 1) chunk[8] = chunk[8]! & ~(VP8X_EXIF | VP8X_XMP);
      parts.push(chunk);
    }
    pos = end;
  }
  if (!parts.length) return null;
  const body = concat(parts);
  const out = new Uint8Array(12 + body.length);
  out.set(b.subarray(0, 12));
  out.set(body, 12);
  const riff = out.length - 8;
  out[4] = riff & 0xff;
  out[5] = (riff >>> 8) & 0xff;
  out[6] = (riff >>> 16) & 0xff;
  out[7] = (riff >>> 24) & 0xff;
  return out;
}

// ---- GIF: a header, colour tables, and image and extension blocks made of length-prefixed sub-blocks ----

/** The end of a run of sub-blocks starting at `at`, past its zero terminator; -1 when it runs off the file. */
function subBlocksEnd(b: Uint8Array, at: number): number {
  let p = at;
  for (;;) {
    if (p >= b.length) return -1;
    const n = b[p]!;
    p += 1 + n;
    if (n === 0) return p;
  }
}

/**
 * The extensions a GIF keeps: the graphic control block (frame delay, transparency) and the looping block of an
 * animation. Comments, plain-text blocks and every other application block (XMP among them) are dropped.
 */
function keepGifExtension(b: Uint8Array, at: number): boolean {
  const label = b[at + 1];
  if (label === 0xf9) return true;
  if (label === 0xff) return b[at + 2] === 11 && (ascii(b, at + 3, "NETSCAPE2.0") || ascii(b, at + 3, "ANIMEXTS1.0"));
  return false;
}

function stripGif(b: Uint8Array): Uint8Array | null {
  if (b.length < 13 || !(ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a"))) return null;
  const table = (flags: number) => (flags & 0x80 ? 3 * (1 << ((flags & 7) + 1)) : 0);
  let pos = 13 + table(b[10]!);
  if (pos > b.length) return null;
  const parts: Uint8Array[] = [b.subarray(0, pos)];
  for (;;) {
    if (pos >= b.length) return null;
    const block = b[pos]!;
    if (block === 0x3b) {
      parts.push(b.subarray(pos, pos + 1));
      return concat(parts);
    }
    let end: number;
    if (block === 0x2c) {
      if (pos + 10 > b.length) return null;
      const data = pos + 10 + table(b[pos + 9]!) + 1; // past the local colour table and the LZW code size
      end = subBlocksEnd(b, data);
      if (end < 0) return null;
      parts.push(b.subarray(pos, end));
    } else if (block === 0x21) {
      end = subBlocksEnd(b, pos + 2);
      if (end < 0) return null;
      if (keepGifExtension(b, pos)) parts.push(b.subarray(pos, end));
    } else return null;
    pos = end;
  }
}

// ---- AVIF: ISOBMFF boxes; metadata is an item in the meta box, its bytes located by the iloc box ----

interface Box {
  type: string;
  start: number;
  body: number;
  end: number;
}

function* boxes(b: Uint8Array, from: number, to: number): Generator<Box> {
  let pos = from;
  while (pos + 8 <= to) {
    let size = u32be(b, pos);
    const type = String.fromCharCode(b[pos + 4]!, b[pos + 5]!, b[pos + 6]!, b[pos + 7]!);
    let body = pos + 8;
    if (size === 1) {
      if (pos + 16 > to) throw new Error("box header");
      size = u32be(b, pos + 8) * 2 ** 32 + u32be(b, pos + 12);
      body = pos + 16;
    } else if (size === 0) size = to - pos;
    const end = pos + size;
    if (end > to || end < body) throw new Error("box size");
    yield { type, start: pos, body, end };
    pos = end;
  }
  if (pos !== to) throw new Error("box tail");
}

function uint(b: Uint8Array, at: number, n: number): number {
  if (n === 0) return 0;
  if (n === 4) return u32be(b, at);
  if (n === 8) return u32be(b, at) * 2 ** 32 + u32be(b, at + 4);
  throw new Error("field size");
}

/** A null-terminated string in an item info entry, and where the next field starts. */
function cstring(b: Uint8Array, at: number, end: number): [string, number] {
  let i = at;
  while (i < end && b[i] !== 0) i++;
  return [String.fromCharCode(...b.subarray(at, i)), i + 1];
}

/** The ids of the meta box's Exif items and XMP items (a `mime` item of type application/rdf+xml). */
function metadataItems(b: Uint8Array, iinf: Box): Set<number> {
  const ids = new Set<number>();
  const version = b[iinf.body]!;
  const first = iinf.body + 4 + (version === 0 ? 2 : 4);
  for (const infe of boxes(b, first, iinf.end)) {
    if (infe.type !== "infe") continue;
    const v = b[infe.body]!;
    let p = infe.body + 4;
    if (v < 2) {
      const id = u16be(b, p);
      p += 4;
      const [, afterName] = cstring(b, p, infe.end);
      const [type] = cstring(b, afterName, infe.end);
      if (type === "application/rdf+xml") ids.add(id);
      continue;
    }
    const id = v === 2 ? u16be(b, p) : u32be(b, p);
    p += (v === 2 ? 2 : 4) + 2;
    const kind = String.fromCharCode(b[p]!, b[p + 1]!, b[p + 2]!, b[p + 3]!);
    if (kind === "Exif") ids.add(id);
    else if (kind === "mime") {
      const [, afterName] = cstring(b, p + 4, infe.end);
      const [type] = cstring(b, afterName, infe.end);
      if (type === "application/rdf+xml") ids.add(id);
    }
  }
  return ids;
}

/**
 * The AVIF with the bytes of its Exif and XMP items overwritten with zeros. The boxes stay where they are, so
 * every offset in the file still holds and the picture draws as before; the metadata items are left empty.
 */
function blankAvifMetadata(b: Uint8Array): Uint8Array | null {
  const top = [...boxes(b, 0, b.length)];
  if (top[0]?.type !== "ftyp") return null;
  const meta = top.find((x) => x.type === "meta");
  if (!meta) return b;
  const inner = [...boxes(b, meta.body + 4, meta.end)];
  const iinf = inner.find((x) => x.type === "iinf");
  const iloc = inner.find((x) => x.type === "iloc");
  const idat = inner.find((x) => x.type === "idat");
  const ids = iinf ? metadataItems(b, iinf) : new Set<number>();
  if (!ids.size) return b;
  if (!iloc) return null;
  const out = b.slice();
  const v = b[iloc.body]!;
  let p = iloc.body + 4;
  const offsetSize = b[p]! >> 4;
  const lengthSize = b[p]! & 15;
  const baseSize = b[p + 1]! >> 4;
  const indexSize = v === 1 || v === 2 ? b[p + 1]! & 15 : 0;
  p += 2;
  const count = v < 2 ? u16be(b, p) : u32be(b, p);
  p += v < 2 ? 2 : 4;
  for (let n = 0; n < count; n++) {
    const id = v < 2 ? u16be(b, p) : u32be(b, p);
    p += v < 2 ? 2 : 4;
    const method = v === 1 || v === 2 ? u16be(b, p) & 15 : 0;
    if (v === 1 || v === 2) p += 2;
    const dataRef = u16be(b, p);
    p += 2;
    const base = uint(b, p, baseSize);
    p += baseSize;
    const extents = u16be(b, p);
    p += 2;
    for (let e = 0; e < extents; e++) {
      p += indexSize;
      const off = uint(b, p, offsetSize);
      p += offsetSize;
      const len = uint(b, p, lengthSize);
      p += lengthSize;
      if (p > iloc.end) return null;
      if (!ids.has(id) || dataRef !== 0) continue;
      // a metadata item must name its bytes exactly: in the file, or inside the meta box's own idat
      if (len === 0 || method === 2) return null;
      const origin = method === 1 ? (idat ? idat.body : -1) : 0;
      const limit = method === 1 ? (idat ? idat.end : -1) : b.length;
      const from = origin + base + off;
      if (origin < 0 || from + len > limit) return null;
      out.fill(0, from, from + len);
    }
  }
  return out;
}
