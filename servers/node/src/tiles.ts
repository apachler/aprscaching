// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The offline map archive as a file (OFFLINE_TILES_PATH), read by byte range for /tiles/offline.pmtiles.
 * The file is opened per answer, so a replaced archive is served without a restart, and an answer reads only the
 * copy it opened; its size and modification time are the version tag.
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
    open: async () => {
      let fh: fs.FileHandle;
      try {
        fh = await fs.open(file, "r");
      } catch {
        return null;
      }
      try {
        const s = await fh.stat();
        if (!s.isFile()) throw new Error("not a file");
        let closed = false;
        return {
          size: s.size,
          etag: `${s.size}-${Math.floor(s.mtimeMs)}`,
          read: async (offset, length) => {
            const out = new Uint8Array(length);
            const { bytesRead } = await fh.read(out, 0, length, offset);
            return out.subarray(0, bytesRead);
          },
          close: async () => {
            if (closed) return;
            closed = true;
            await fh.close();
          },
        };
      } catch {
        await fh.close();
        return null;
      }
    },
  };
}
