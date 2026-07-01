import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Split the heavy, rarely-changing vendors into their own chunks so a code-only deploy doesn't force
// a re-download of MapLibre/React (long-term caching + parallel fetch). MapLibre GL is ~800 KB on its
// own — an unavoidable floor for a vector-map app — so the warning limit reflects that reality rather
// than flagging a dependency we can't shrink; the app chunk itself stays under the default budget.
export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          maplibre: ["maplibre-gl"],
          react: ["react", "react-dom"],
        },
      },
    },
  },
});
