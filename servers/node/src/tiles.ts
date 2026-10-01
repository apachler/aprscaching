// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The offline map archive as a file (OFFLINE_TILES_PATH), read by byte range for /tiles/offline.pmtiles.
 * The file is opened per read, so a replaced archive is served without a restart; its size and modification
 * time are the version tag.
 */
import fs from "node:fs/promises";
import type { TileArchive } from "@aprscaching/gateway/runtime";

export function fileTiles(file: string | undefined): TileArchive | undefined {
  if (!file) return undefined;
  return {
    stat: async () => {
      try {
        const s = await fs.stat(file);
        return s.isFile() ? { size: s.size, etag: `${s.size}-${Math.floor(s.mtimeMs)}` } : null;
      } catch {
        return null;
      }
    },
    read: async (offset, length) => {
      const fh = await fs.open(file, "r");
      try {
        const out = new Uint8Array(length);
        const { bytesRead } = await fh.read(out, 0, length, offset);
        return out.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    },
  };
}
