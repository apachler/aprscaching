// SPDX-License-Identifier: AGPL-3.0-or-later
// A stored photo carries none of the Exif, XMP, IPTC or text its camera wrote, and keeps everything that draws it.
import { describe, it, expect } from "vitest";
import { stripImageMetadata } from "../src/imagemeta.js";

const bytes = (...parts: (number[] | string | Uint8Array)[]): Uint8Array => {
  const flat: number[] = [];
  for (const p of parts)
    if (typeof p === "string") for (const c of p) flat.push(c.charCodeAt(0));
    else flat.push(...p);
  return new Uint8Array(flat);
};
const be16 = (n: number) => [(n >> 8) & 255, n & 255];
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const has = (hay: Uint8Array, needle: string) => String.fromCharCode(...hay).includes(needle);

// ---- JPEG ----
const seg = (marker: number, body: Uint8Array | number[] | string) => {
  const b = typeof body === "string" ? bytes(body) : Uint8Array.from(body);
  return bytes([0xff, marker], be16(b.length + 2), b);
};
const JFIF = seg(0xe0, bytes("JFIF\0", [1, 1, 0, 0, 1, 0, 1, 0, 0]));
const EXIF_GPS = seg(0xe1, bytes("Exif\0\0", "MM", [0, 42], "GPSLatitude=47.0712N"));
const XMP = seg(0xe1, bytes("http://ns.adobe.com/xap/1.0/\0", "<x:xmpmeta>home</x:xmpmeta>"));
const ICC = seg(0xe2, bytes("ICC_PROFILE\0", [1, 1], "profile"));
const MPF = seg(0xe2, bytes("MPF\0", "index"));
const IPTC = seg(0xed, bytes("Photoshop 3.0\0", "8BIM city"));
const ADOBE = seg(0xee, bytes("Adobe", [0, 100, 0, 0, 0, 0, 1]));
const COMMENT = seg(0xfe, "taken at home");
const DQT = seg(0xdb, [0, ...new Array<number>(64).fill(1)]);
const SOF = seg(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]);
const SOS = seg(0xda, [1, 1, 0, 0, 63, 0]);
const SCAN = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]; // a stuffed 0xFF and a restart marker inside the scan
const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];

describe("JPEG", () => {
  it("drops Exif, XMP, IPTC, the multi-picture index, comments and what follows EOI", () => {
    const photo = bytes(SOI, JFIF, EXIF_GPS, XMP, ICC, MPF, IPTC, ADOBE, COMMENT, DQT, SOF, SOS, SCAN, EOI, "trailer");
    const out = stripImageMetadata(photo, "image/jpeg")!;
    expect(out).toEqual(bytes(SOI, JFIF, ICC, ADOBE, DQT, SOF, SOS, SCAN, EOI));
    for (const s of ["Exif", "GPSLatitude", "xmpmeta", "Photoshop", "MPF", "at home", "trailer"])
      expect(has(out, s)).toBe(false);
  });

  it("walks the segments between the scans of a progressive JPEG", () => {
    const photo = bytes(SOI, DQT, SOF, SOS, SCAN, [0xff, 0xff], EXIF_GPS, SOS, SCAN, EOI);
    expect(stripImageMetadata(photo, "image/jpeg")).toEqual(bytes(SOI, DQT, SOF, SOS, SCAN, SOS, SCAN, EOI));
  });

  it("leaves a clean JPEG as it is", () => {
    const clean = bytes(SOI, JFIF, DQT, SOF, SOS, SCAN, EOI);
    expect(stripImageMetadata(clean, "image/jpeg")).toEqual(clean);
  });

  it("refuses what is not a whole JPEG", () => {
    expect(stripImageMetadata(bytes([1, 2, 3]), "image/jpeg")).toBeNull();
    expect(stripImageMetadata(bytes(SOI, EXIF_GPS, SOS, SCAN), "image/jpeg")).toBeNull(); // no EOI
    expect(stripImageMetadata(bytes(SOI, [0xff, 0xe1, 0x40, 0], "Exif"), "image/jpeg")).toBeNull(); // runs off the end
    expect(stripImageMetadata(bytes(SOI, [0x00]), "image/jpeg")).toBeNull();
  });
});

// ---- PNG ----
const chunk = (type: string, data: Uint8Array | number[] | string) => {
  const d = typeof data === "string" ? bytes(data) : Uint8Array.from(data);
  return bytes(be32(d.length), type, d, [0, 0, 0, 0]);
};
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = chunk("IHDR", [...be32(1), ...be32(1), 8, 6, 0, 0, 0]);
const IDAT = chunk("IDAT", [1, 2, 3]);
const IEND = chunk("IEND", []);

describe("PNG", () => {
  it("keeps the picture, its colour and transparency, and drops text, eXIf and timestamps", () => {
    const keep = [
      chunk("sRGB", [0]),
      chunk("gAMA", be32(45455)),
      chunk("tRNS", [0, 0]),
      chunk("pHYs", new Array(9).fill(0)),
    ];
    const photo = bytes(
      PNG_SIG,
      IHDR,
      chunk("eXIf", "MM\0*GPSLatitude"),
      ...keep,
      chunk("tEXt", "Comment\0at home"),
      chunk("iTXt", "XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>"),
      chunk("zTXt", "Raw profile type exif\0\0zz"),
      chunk("tIME", [7, 234, 10, 15, 12, 0, 0]),
      chunk("prVt", "vendor"),
      IDAT,
      IEND,
      "after",
    );
    expect(stripImageMetadata(photo, "image/png")).toEqual(bytes(PNG_SIG, IHDR, ...keep, IDAT, IEND));
  });

  it("refuses what is not a whole PNG", () => {
    expect(stripImageMetadata(bytes(PNG_SIG, [1, 2, 3, 4]), "image/png")).toBeNull();
    expect(stripImageMetadata(bytes(PNG_SIG, IHDR, IDAT), "image/png")).toBeNull(); // no IEND
    expect(stripImageMetadata(bytes(PNG_SIG, IDAT, IEND), "image/png")).toBeNull(); // IHDR first
    expect(stripImageMetadata(bytes(PNG_SIG, IHDR, chunk("ZZZZ", [1]), IDAT, IEND), "image/png")).toBeNull();
  });
});

// ---- WebP ----
const riffChunk = (fourcc: string, data: number[] | string) => {
  const d = typeof data === "string" ? bytes(data) : Uint8Array.from(data);
  return bytes(fourcc, le32(d.length), d, d.length & 1 ? [0] : []);
};
const riff = (...chunks: Uint8Array[]) => {
  const body = bytes("WEBP", ...chunks);
  return bytes("RIFF", le32(body.length), body);
};

describe("WebP", () => {
  it("drops the EXIF and XMP chunks, clears their VP8X flags and fixes the RIFF size", () => {
    const vp8x = (flags: number) => riffChunk("VP8X", [flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const iccp = riffChunk("ICCP", "profile");
    const image = riffChunk("VP8L", [0x2f, 0, 0, 0, 0]); // odd length: padded
    const photo = riff(
      vp8x(0x20 | 0x08 | 0x04),
      iccp,
      image,
      riffChunk("EXIF", "MM\0*GPS"),
      riffChunk("XMP ", "<x:xmpmeta/>"),
    );
    expect(stripImageMetadata(photo, "image/webp")).toEqual(riff(vp8x(0x20), iccp, image));
  });

  it("leaves a simple WebP as it is, and refuses what is not one", () => {
    const simple = riff(riffChunk("VP8 ", [1, 2, 3, 4]));
    expect(stripImageMetadata(simple, "image/webp")).toEqual(simple);
    expect(stripImageMetadata(riff(riffChunk("EXIF", "MM\0*")), "image/webp")).toBeNull();
    expect(stripImageMetadata(bytes("RIFF", le32(100), "WEBPVP8 ", le32(90), [1]), "image/webp")).toBeNull();
  });
});

// ---- GIF ----
const GIF_HEAD = bytes("GIF89a", [1, 0, 1, 0, 0x80, 0, 0], [0, 0, 0, 255, 255, 255]); // a two-colour global table
const LOOP = bytes([0x21, 0xff, 11], "NETSCAPE2.0", [3, 1, 0, 0, 0]);
const GCE = bytes([0x21, 0xf9, 4, 0, 10, 0, 0, 0]);
const FRAME = bytes([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0], [2, 2, 0x4c, 0x01, 0]);

describe("GIF", () => {
  it("keeps the frames, their timing and the loop, and drops comments and XMP", () => {
    const xmp = bytes([0x21, 0xff, 11], "XMP DataXMP", [12], "<x:xmpmeta/>", [0]);
    const comment = bytes([0x21, 0xfe, 7], "at home", [0]);
    const photo = bytes(GIF_HEAD, LOOP, xmp, GCE, FRAME, comment, GCE, FRAME, [0x3b], "after");
    expect(stripImageMetadata(photo, "image/gif")).toEqual(bytes(GIF_HEAD, LOOP, GCE, FRAME, GCE, FRAME, [0x3b]));
  });

  it("refuses what is not a whole GIF", () => {
    expect(stripImageMetadata(bytes(GIF_HEAD, FRAME), "image/gif")).toBeNull();
    expect(stripImageMetadata(bytes(GIF_HEAD, [0x99]), "image/gif")).toBeNull();
    expect(stripImageMetadata(bytes("GIF89a"), "image/gif")).toBeNull();
  });
});

// ---- AVIF ----
const box = (type: string, ...body: (number[] | string | Uint8Array)[]) => {
  const b = bytes(...body);
  return bytes(be32(b.length + 8), type, b);
};
const full = (type: string, version: number, ...body: (number[] | string | Uint8Array)[]) =>
  box(type, [version, 0, 0, 0], ...body);
const infe = (id: number, type: string, extra = "") => full("infe", 2, be16(id), be16(0), type, "\0", extra);

/** An AVIF with an image item (1), an Exif item (2) and an XMP item (3), the last two at the end of the file. */
function avif(exifAt: "file" | "idat") {
  const exif = bytes([0, 0, 0, 6], "Exif\0\0MM\0*GPS47N");
  const xmp = bytes("<x:xmpmeta>home</x:xmpmeta>");
  const ftyp = box("ftyp", "avif", be32(0), "avifmif1");
  const iinf = full("iinf", 0, be16(3), infe(1, "av01"), infe(2, "Exif"), infe(3, "mime", "application/rdf+xml\0"));
  const idat = exifAt === "idat" ? box("idat", exif) : bytes();
  // iloc v1: 4-byte offsets and lengths, no base offset; item 2 lives in idat when asked
  const iloc = (pixels: number, exifOff: number, xmpOff: number) =>
    full(
      "iloc",
      1,
      [0x44, 0x00],
      be16(3),
      [...be16(1), 0, 0, ...be16(0), ...be16(1), ...be32(pixels), ...be32(4)],
      [...be16(2), 0, exifAt === "idat" ? 1 : 0, ...be16(0), ...be16(1), ...be32(exifOff), ...be32(exif.length)],
      [...be16(3), 0, 0, ...be16(0), ...be16(1), ...be32(xmpOff), ...be32(xmp.length)],
    );
  const metaLen = (il: Uint8Array) =>
    full("meta", 0, full("hdlr", 0, be32(0), "pict", new Array(13).fill(0)), iinf, il, idat).length;
  const probe = iloc(0, 0, 0);
  const mdatStart = ftyp.length + metaLen(probe);
  const pixels = mdatStart + 8;
  const exifOff = exifAt === "idat" ? 0 : pixels + 4;
  const xmpOff = exifAt === "idat" ? pixels + 4 : pixels + 4 + exif.length;
  const meta = full(
    "meta",
    0,
    full("hdlr", 0, be32(0), "pict", new Array(13).fill(0)),
    iinf,
    iloc(pixels, exifOff, xmpOff),
    idat,
  );
  const mdat = box("mdat", [9, 9, 9, 9], exifAt === "idat" ? bytes() : exif, xmp);
  return { file: bytes(ftyp, meta, mdat), pixels, exif, xmp };
}

describe("AVIF", () => {
  it("blanks the Exif and XMP items in place and leaves the picture's bytes alone", () => {
    for (const where of ["file", "idat"] as const) {
      const a = avif(where);
      const out = stripImageMetadata(a.file, "image/avif")!;
      expect(out.length).toBe(a.file.length);
      expect(has(out, "GPS47N"), where).toBe(false);
      expect(has(out, "xmpmeta"), where).toBe(false);
      expect([...out.subarray(a.pixels, a.pixels + 4)]).toEqual([9, 9, 9, 9]);
      expect(has(out, "application/rdf+xml")).toBe(true); // the item list itself stays, only the bytes go
    }
  });

  it("leaves an AVIF without metadata as it is, and refuses what is not one", () => {
    const plain = bytes(box("ftyp", "avif", be32(0)), box("mdat", [1, 2]));
    expect(stripImageMetadata(plain, "image/avif")).toEqual(plain);
    expect(stripImageMetadata(bytes(box("mdat", [1])), "image/avif")).toBeNull();
    expect(stripImageMetadata(bytes(be32(400), "ftyp"), "image/avif")).toBeNull();
  });
});

describe("other types", () => {
  it("pass through unchanged", () => {
    const b = bytes([1, 2, 3]);
    expect(stripImageMetadata(b, "audio/mpeg")).toBe(b);
  });
});
