// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * vite-vendor — publish the app's own MapLibre build at a stable path (MAPLIBRE_VENDOR_DIR) for the
 * gateway's embeddable map widget, so `/embed` loads MapLibre from the instance instead of a CDN.
 *
 * MapLibre ships ES modules only: an entry and a worker, either self-contained or both importing a shared
 * chunk (a release decides which). They are published with a `.js` extension, because every host maps
 * `.js` to JavaScript while `.mjs` depends on each server's MIME table, and a module script served with
 * the wrong type does not run. When the entry and the worker import the chunk, that one specifier is
 * rewritten and the chunk is published too; the build fails when only one of them imports it, or when either
 * names the chunk some other way, since the copy would then load a file that is not there. The widget sets
 * the worker's URL itself, so the entry's own default worker name never matters. The source-map comments are
 * dropped, since the maps are not published. The build also fails if the installed maplibre-gl has another
 * major than the widget is written for.
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
      const quoted = `"${SHARED}"`;
      const entry = read("maplibre-gl.mjs");
      const worker = read("maplibre-gl-worker.mjs");
      const split = [entry, worker].map((src) => src.includes(quoted));
      if (split[0] !== split[1]) {
        this.error(`maplibre-gl ${version}: only ${split[0] ? "the entry" : "the worker"} imports ${SHARED}`);
      }
      const relink = (f: string, src: string) => {
        const rest = split[0] ? src.split(quoted).join("") : src;
        if (rest.includes("maplibre-gl-shared")) this.error(`maplibre-gl ${version}: ${f} names its chunk another way`);
        return split[0] ? src.split(quoted).join(`"./maplibre-gl-shared.js"`) : src;
      };
      const files: Record<string, string> = {
        "maplibre-gl.js": relink("maplibre-gl.mjs", entry),
        "maplibre-gl-worker.js": relink("maplibre-gl-worker.mjs", worker),
        ...(split[0] ? { "maplibre-gl-shared.js": read("maplibre-gl-shared.mjs") } : {}),
        "maplibre-gl.css": read("maplibre-gl.css"),
      };
      for (const [name, source] of Object.entries(files)) {
        this.emitFile({ type: "asset", fileName: `${MAPLIBRE_VENDOR_DIR}/${name}`, source });
      }
    },
  };
}
