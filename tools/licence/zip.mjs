// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-check
// A streaming reader for the zip archives licence registers publish (FCC l_amat.zip, ISED
// amateur_delim.zip, ACMA spectra_rrl.zip). It reads the central directory, then inflates one entry at a
// time straight from disk, so a 240 MB member never sits in memory. Stored and deflated members are
// supported; zip64 archives (members over 4 GiB) are refused with a clear error.
import fs from "node:fs";
import zlib from "node:zlib";
import readline from "node:readline";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * @typedef {{ name: string, method: number, compressedSize: number, localOffset: number }} ZipEntry
 */

/** @param {string} file @returns {Promise<ZipEntry[]>} */
export async function listEntries(file) {
  const fh = await fs.promises.open(file, "r");
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65535 + 22);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--)
      if (tail.readUInt32LE(i) === EOCD) {
        eocd = i;
        break;
      }
    if (eocd < 0) throw new Error(`${file}: not a zip archive`);
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdOffset === 0xffffffff) throw new Error(`${file}: zip64 archives are not supported`);
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    /** @type {ZipEntry[]} */
    const out = [];
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (cd.readUInt32LE(p) !== CENTRAL) throw new Error(`${file}: corrupt central directory`);
      const method = cd.readUInt16LE(p + 10);
      const compressedSize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
      if (compressedSize === 0xffffffff || localOffset === 0xffffffff)
        throw new Error(`${file}: zip64 member ${name} is not supported`);
      out.push({ name, method, compressedSize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } finally {
    await fh.close();
  }
}

/**
 * The lines of one member, decoded as latin1 (register fields that matter are ASCII; latin1 never
 * splits a byte sequence, so `;`, `|` and `,` delimiters stay intact in UTF-8 files too).
 * @param {string} file @param {ZipEntry} entry @returns {AsyncIterable<string>}
 */
export async function* entryLines(file, entry) {
  const fh = await fs.promises.open(file, "r");
  let start;
  try {
    const lh = Buffer.alloc(30);
    await fh.read(lh, 0, 30, entry.localOffset);
    if (lh.readUInt32LE(0) !== LOCAL) throw new Error(`${file}: corrupt local header for ${entry.name}`);
    start = entry.localOffset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  } finally {
    await fh.close();
  }
  if (entry.compressedSize === 0) return;
  const raw = fs.createReadStream(file, { start, end: start + entry.compressedSize - 1 });
  let body;
  if (entry.method === 0) body = raw;
  else if (entry.method === 8) body = raw.pipe(zlib.createInflateRaw());
  else throw new Error(`${file}: ${entry.name} uses unsupported compression method ${entry.method}`);
  raw.on("error", (e) => body.destroy(e));
  body.setEncoding("latin1");
  yield* readline.createInterface({ input: body, crlfDelay: Infinity });
}

/**
 * The lines of the first member whose base name matches `pattern` (case-insensitive).
 * @param {string} file @param {RegExp} pattern @returns {AsyncIterable<string>}
 */
export async function* memberLines(file, pattern) {
  const entry = (await listEntries(file)).find((e) => pattern.test(e.name.split("/").pop() ?? ""));
  if (!entry) throw new Error(`${file}: no member matching ${String(pattern)}`);
  yield* entryLines(file, entry);
}
