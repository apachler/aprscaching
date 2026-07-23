// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from "node:fs";
import path from "node:path";
import type { MediaStore } from "@aprscaching/gateway/runtime";

/** Filesystem-backed MediaStore (Bun analogue of servers/node/media.ts; node:fs works under Bun). */
export function makeFsMedia(root: string): MediaStore {
  fs.mkdirSync(root, { recursive: true });
  const base = path.resolve(root);
  // allowlist the server-built key shape + assert path.resolve containment (a `..`-strip is
  // defeatable) so no media key can escape the store root.
  const safe = (key: string): string => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(key) || key.includes("..")) throw new Error(`unsafe media key: ${key}`);
    const file = path.resolve(base, key);
    if (file !== base && !file.startsWith(base + path.sep)) throw new Error(`media key escapes store: ${key}`);
    return file;
  };
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
      const contentType = fs.existsSync(file + ".ct")
        ? fs.readFileSync(file + ".ct", "utf8")
        : "application/octet-stream";
      return { bytes, contentType };
    },
    async delete(key) {
      const file = safe(key);
      fs.rmSync(file, { force: true });
      fs.rmSync(file + ".ct", { force: true });
    },
  };
}
