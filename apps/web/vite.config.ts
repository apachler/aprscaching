// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vendor chunking + preload policy for the landing-vs-platform split:
//  - React is an eager entry dependency → its own long-term-cacheable chunk.
//  - MapLibre (~800 KB, an unshrinkable vector-map floor) gets its own chunk too so a code-only deploy
//    doesn't force a re-download — but it is reachable ONLY through the lazily-imported Platform.
//  - resolveDependencies strips MapLibre from the preload graph so Vite does NOT hoist a modulepreload
//    for it into index.html; the signed-out landing therefore never fetches it. It loads on demand when
//    Platform mounts (explore / sign-in). The warning limit reflects MapLibre's real size.
export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 900,
    modulePreload: {
      resolveDependencies: (_url, deps) => deps.filter((d) => !d.includes("maplibre")),
    },
    rollupOptions: {
      output: {
        // Function form (not the object map): Vite 8 bundles with Rolldown, which accepts a
        // manualChunks(id) callback but not the legacy object syntax. Same intent as before —
        // MapLibre and React each land in their own long-term-cacheable chunk (scheduler, a
        // react-dom dependency, rides in the react chunk).
        manualChunks(id) {
          if (id.includes("node_modules/maplibre-gl")) return "maplibre";
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "react";
        },
      },
    },
  },
});
