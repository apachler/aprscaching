#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// CI guard: the web build publishes MapLibre where the gateway's embed widget loads it from.
//
// `/embed` is served by the gateway but loads MapLibre from the app origin at MAPLIBRE_VENDOR_DIR, so
// nothing in either unit's own build notices when the two ends disagree — the widget just renders a
// blank frame on every instance. This checks the built output: each file is present, the module entry
// and the worker import their shared chunk by the published name, and nothing still points at `.mjs`.
// It runs after `vite build` (the package's `build` precedes `test` in `pnpm -r`); with no build at all
// it says so and passes, so the unit tests stay runnable on their own.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MAPLIBRE_VENDOR_DIR } from "../../../packages/shared/src/basemap.ts";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
if (!existsSync(join(DIST, "index.html"))) {
  console.log("vendor-maplibre: no build in apps/web/dist — skipped");
  process.exit(0);
}
const dir = join(DIST, MAPLIBRE_VENDOR_DIR);
const files = ["maplibre-gl.js", "maplibre-gl-shared.js", "maplibre-gl-worker.js", "maplibre-gl.css"];
const problems = [];
for (const f of files) if (!existsSync(join(dir, f))) problems.push(`missing ${MAPLIBRE_VENDOR_DIR}/${f}`);
for (const f of ["maplibre-gl.js", "maplibre-gl-worker.js"]) {
  if (!existsSync(join(dir, f))) continue;
  const src = readFileSync(join(dir, f), "utf8");
  if (!src.includes('"./maplibre-gl-shared.js"')) problems.push(`${f} does not import ./maplibre-gl-shared.js`);
  if (src.includes("maplibre-gl-shared.mjs")) problems.push(`${f} still imports the .mjs chunk`);
}
const headers = join(DIST, "_headers");
if (!existsSync(headers) || !/^\/vendor\/\*\s*$/m.test(readFileSync(headers, "utf8"))) {
  problems.push("_headers does not open /vendor/* to cross-origin module loads");
}
if (problems.length) {
  console.error("vendor-maplibre: the embed widget's MapLibre copy is incomplete:");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`vendor-maplibre: ${files.length} files in dist/${MAPLIBRE_VENDOR_DIR}`);
