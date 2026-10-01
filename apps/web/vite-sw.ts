// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * vite-sw — write the offline app shell into the service worker (public/sw.js) at build time.
 *
 * The precache list is everything the build emitted (index.html and the hashed bundles, MapLibre
 * included, so the map opens offline) plus each file from public/ that the built app references by its
 * path — the fonts in the CSS, the brand images in the code, the icons and the manifest in index.html.
 * The iOS launch screens, the embed widget's MapLibre copy and anything nothing references stay out.
 * The version is a hash of the list and of every listed file, so any change makes a new worker, whose
 * install stores the new files and whose activation deletes the old ones.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

/** Public files never precached, however they are referenced. */
const SKIP = [/^icons\/splash\//, /^vendor\//, /^shots\//, /^_headers$/, /^sw\.js$/, /\.map$/, /\.txt$/];

function walk(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p, base) : [path.relative(base, p).split(path.sep).join("/")];
  });
}

/** The files to precache, as absolute URL paths, sorted. */
export function precacheList(outDir: string, emitted: string[]): string[] {
  const keep = (f: string) => !SKIP.some((re) => re.test(f));
  const built = emitted.filter(keep);
  const text = built
    .filter((f) => /\.(html|js|css|webmanifest)$/.test(f))
    .concat(fs.existsSync(path.join(outDir, "manifest.webmanifest")) ? ["manifest.webmanifest"] : [])
    .map((f) => fs.readFileSync(path.join(outDir, f), "utf8"))
    .join("\n");
  const builtSet = new Set(built);
  const referenced = walk(outDir).filter((f) => keep(f) && !builtSet.has(f) && text.includes(`/${f}`));
  return [...new Set([...built, ...referenced])].map((f) => `/${f}`).sort();
}

export function serviceWorkerPlugin(): Plugin {
  let outDir = "";
  return {
    name: "aprscaching-sw",
    apply: "build",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    writeBundle(_options, bundle) {
      const swPath = path.join(outDir, "sw.js");
      const list = precacheList(outDir, Object.keys(bundle));
      const hash = createHash("sha256");
      for (const u of list) hash.update(u).update(fs.readFileSync(path.join(outDir, u.slice(1))));
      const version = hash.digest("hex").slice(0, 16);
      const src = fs.readFileSync(swPath, "utf8");
      const out = src
        .replace(/^const VERSION = "dev";$/m, `const VERSION = ${JSON.stringify(version)};`)
        .replace(/^const PRECACHE = \[\];$/m, `const PRECACHE = ${JSON.stringify(list)};`);
      if (!out.includes(version) || out.includes("const PRECACHE = [];"))
        this.error("sw.js no longer has the VERSION / PRECACHE lines the build fills in");
      fs.writeFileSync(swPath, out);
    },
  };
}
