// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * vite-vendor — publish the app's own MapLibre build at a stable path (MAPLIBRE_VENDOR_DIR) for the
 * gateway's embeddable map widget, so `/embed` loads MapLibre from the instance instead of a CDN.
 *
 * MapLibre ships ES modules only: an entry, a worker, and the chunk both import. They are published
 * with a `.js` extension, because every host maps `.js` to JavaScript while `.mjs` depends on each
 * server's MIME table, and a module script served with the wrong type does not run. The entry and the
 * worker import the chunk by name, so that one specifier is rewritten; the build fails if it is missing.
 * The source-map comments are dropped, since the maps are not published. The build also fails if the
 * installed maplibre-gl has another major than the widget is written for.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Plugin } from "vite";
import { MAPLIBRE_MAJOR, MAPLIBRE_VENDOR_DIR } from "../../packages/shared/src/basemap.js";

const SHARED = "./maplibre-gl-shared.mjs";

export function vendorMaplibrePlugin(): Plugin {
  return {
    name: "aprscaching-vendor-maplibre",
    apply: "build",
    generateBundle() {
      const require = createRequire(import.meta.url);
      const pkgPath = require.resolve("maplibre-gl/package.json");
      const { version } = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version: string };
      if (Number(version.split(".")[0]) !== MAPLIBRE_MAJOR) {
        this.error(`maplibre-gl ${version} is installed, but the embed widget targets major ${MAPLIBRE_MAJOR}`);
      }
      const dist = path.join(path.dirname(pkgPath), "dist");
      const read = (f: string) =>
        fs.readFileSync(path.join(dist, f), "utf8").replace(/\n\/\/# sourceMappingURL=\S+\s*$/, "\n");
      const relink = (f: string) => {
        const src = read(f);
        const quoted = `"${SHARED}"`;
        if (!src.includes(quoted)) this.error(`maplibre-gl ${version}: ${f} no longer imports ${SHARED}`);
        return src.split(quoted).join(`"./maplibre-gl-shared.js"`);
      };
      const files: Record<string, string> = {
        "maplibre-gl.js": relink("maplibre-gl.mjs"),
        "maplibre-gl-worker.js": relink("maplibre-gl-worker.mjs"),
        "maplibre-gl-shared.js": read("maplibre-gl-shared.mjs"),
        "maplibre-gl.css": read("maplibre-gl.css"),
      };
      for (const [name, source] of Object.entries(files)) {
        this.emitFile({ type: "asset", fileName: `${MAPLIBRE_VENDOR_DIR}/${name}`, source });
      }
    },
  };
}
