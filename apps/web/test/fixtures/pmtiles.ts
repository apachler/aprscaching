// SPDX-License-Identifier: AGPL-3.0-or-later
// A small PMTiles v3 archive built in memory, for the tile tests and the offline browser test.
import { zxyToTileId } from "pmtiles";

/** A PMTiles v3 archive (uncompressed, one root directory) holding `tiles`, as the spec lays it out. */
export function buildArchive(tiles: { z: number; x: number; y: number; bytes: number[] }[]): Uint8Array {
  const entries = tiles
    .map((t) => ({ id: zxyToTileId(t.z, t.x, t.y), data: Uint8Array.from(t.bytes) }))
    .sort((a, b) => a.id - b.id);
  const varint = (out: number[], n: number) => {
    while (n >= 0x80) {
      out.push((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    out.push(n);
  };
  const dir: number[] = [];
  varint(dir, entries.length);
  let last = 0;
  for (const e of entries) (varint(dir, e.id - last), (last = e.id));
  for (let i = 0; i < entries.length; i++) varint(dir, 1); // run lengths
  for (const e of entries) varint(dir, e.data.length);
  for (let i = 0; i < entries.length; i++) varint(dir, i === 0 ? 1 : 0); // offset+1, then contiguous
  const data = entries.flatMap((e) => [...e.data]);
  const h = new DataView(new ArrayBuffer(127));
  "PMTiles".split("").forEach((c, i) => h.setUint8(i, c.charCodeAt(0)));
  h.setUint8(7, 3);
  const u64 = (at: number, v: number) => h.setBigUint64(at, BigInt(v), true);
  u64(8, 127); // root directory offset
  u64(16, dir.length);
  u64(24, 127 + dir.length); // metadata (empty)
  u64(32, 0);
  u64(40, 127 + dir.length); // leaf directories (none)
  u64(48, 0);
  u64(56, 127 + dir.length); // tile data
  u64(64, data.length);
  u64(72, entries.length);
  u64(80, entries.length);
  u64(88, entries.length);
  h.setUint8(96, 1); // clustered
  h.setUint8(97, 1); // internal compression: none
  h.setUint8(98, 1); // tile compression: none
  h.setUint8(99, 1); // tile type: mvt
  h.setUint8(100, Math.min(...tiles.map((t) => t.z)));
  h.setUint8(101, Math.max(...tiles.map((t) => t.z)));
  h.setInt32(102, -180e7, true);
  h.setInt32(106, -85e7, true);
  h.setInt32(110, 180e7, true);
  h.setInt32(114, 85e7, true);
  return Uint8Array.from([...new Uint8Array(h.buffer), ...dir, ...data]);
}
