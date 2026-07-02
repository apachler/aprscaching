// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from "node:fs";
import path from "node:path";
import type { MediaStore } from "@aprsweb/gateway/runtime";

/** Filesystem-backed MediaStore (the Node analogue of an R2 bucket). Content-type kept in a sidecar. */
export function makeFsMedia(root: string): MediaStore {
  fs.mkdirSync(root, { recursive: true });
  const safe = (key: string) => path.join(root, key.replace(/\.\./g, "").replace(/^\/+/, ""));
  return {
    async put(key, bytes, contentType) {
      const file = safe(key);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
      fs.writeFileSync(file + ".ct", contentType);
    },
    async get(key) {
      const file = safe(key);
      if (!fs.existsSync(file)) return null;
      const bytes = new Uint8Array(fs.readFileSync(file));
      const contentType = fs.existsSync(file + ".ct") ? fs.readFileSync(file + ".ct", "utf8") : "application/octet-stream";
      return { bytes, contentType };
    },
    async delete(key) {
      const file = safe(key);
      fs.rmSync(file, { force: true });
      fs.rmSync(file + ".ct", { force: true });
    },
  };
}
