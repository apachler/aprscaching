// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * vite-notices — fail the build when a package compiled into the bundle has no entry in
 * public/third-party-notices.txt.
 *
 * Minifying strips the libraries' licence headers, so the notices file is where their copyright notices
 * and licence texts reach the user. It is written by hand; this check keeps it complete. The list of
 * packages comes from the build itself: every module the bundler placed in an emitted chunk is a file
 * under some `node_modules/<package>/`, so the packages that ship are exactly the ones named in those
 * module paths. A dependency that is installed but tree-shaken away, or only used at build time, never
 * appears, and one pulled in transitively always does. The app's own workspace packages
 * (`@aprscaching/*`) are AGPL or MIT under this repository's own licence and need no entry. A library that
 * arrives already bundled inside another package's prebuilt file (MapLibre's own dependencies, such as
 * `@mapbox/jsonlint-lines-primitives`) is invisible here, so its entry is kept by hand.
 *
 * A package counts as listed when its name appears in the notices file as a whole word, in any case (the
 * file names uPlot as its author does).
 */
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

/** The package a module path belongs to (the innermost `node_modules/` segment), or null for app code. */
export function packageOf(moduleId: string): string | null {
  const id = moduleId.replace(/\\/g, "/").replace(/^\0/, "");
  const at = id.lastIndexOf("/node_modules/");
  if (at < 0) return null;
  const parts = id.slice(at + "/node_modules/".length).split("/");
  const name = parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1] ?? ""}` : parts[0];
  return name && !name.startsWith(".") ? name : null;
}

/** The bundled packages the notices text does not name, sorted. Workspace packages are skipped. */
export function missingNotices(packages: Iterable<string>, notices: string): string[] {
  const missing = new Set<string>();
  for (const p of packages) {
    if (p.startsWith("@aprscaching/")) continue;
    const word = new RegExp(`(^|[^\\w@/.-])${p.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?![\\w/-])`, "im");
    if (!word.test(notices)) missing.add(p);
  }
  return [...missing].sort();
}

export function noticesPlugin(webDir: string): Plugin {
  return {
    name: "aprscaching-third-party-notices",
    apply: "build",
    generateBundle(_options, bundle) {
      const packages = new Set<string>();
      for (const out of Object.values(bundle)) {
        if (out.type !== "chunk") continue;
        for (const id of out.moduleIds ?? Object.keys(out.modules)) {
          const p = packageOf(id);
          if (p) packages.add(p);
        }
      }
      const notices = fs.readFileSync(path.join(webDir, "public/third-party-notices.txt"), "utf8");
      const missing = missingNotices(packages, notices);
      if (missing.length) {
        this.error(
          `public/third-party-notices.txt has no entry for ${missing.length} bundled package(s): ${missing.join(", ")}. ` +
            "Add each one's copyright notice and licence text.",
        );
      }
    },
  };
}
