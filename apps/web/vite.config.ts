// SPDX-License-Identifier: AGPL-3.0-or-later
import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from "vite";
import { isGatewayPath } from "../../workers/gateway/src/paths.js";
import react from "@vitejs/plugin-react";
import { vendorMaplibrePlugin } from "./vite-vendor.js";
import { serviceWorkerPlugin } from "./vite-sw.js";
import { prerenderLandingPlugin } from "./vite-prerender.js";
import { noticesPlugin } from "./vite-notices.js";

const webDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * index.html's canonical link and Open Graph tags want absolute URLs, so `%APP_ORIGIN%` there becomes the
 * origin of `VITE_APP_URL`. A build that does not know its host leaves the canonical link and `og:url` out
 * (a wrong host is worse than none) and serves `og:image` from its own path.
 */
function appOriginPlugin(origin: string): Plugin {
  return {
    name: "acs-app-origin",
    transformIndexHtml: (html) =>
      origin
        ? html.replaceAll("%APP_ORIGIN%", origin)
        : html
            .replace(/^.*(?:rel="canonical"|property="og:url").*%APP_ORIGIN%.*\n/gm, "")
            .replaceAll("%APP_ORIGIN%", ""),
  };
}

/**
 * The dev server and its gateway on one origin: every path the gateway serves (isGatewayPath, the same list
 * Caddy and the desktop app route by) goes to the local gateway, the live socket included, and Vite serves
 * the rest. The Host header stays the dev server's, so the gateway builds its links (sign-in, media, feeds)
 * on the origin the browser opened; sessions, passkeys and the live socket then work as in production.
 * `DEV_GATEWAY` names the gateway (`pnpm dev` sets it); the default is the one `pnpm dev:gateway` starts.
 */
function gatewayProxy(target: string): Record<string, ProxyOptions> {
  return {
    "^/": {
      target,
      ws: true,
      xfwd: true,
      // Vite answers what the gateway does not serve; returning the URL hands the request back to Vite
      bypass: (req) => (isGatewayPath(new URL(req.url ?? "/", "http://dev").pathname) ? undefined : req.url),
    },
  };
}

function originOf(url: string | undefined): string {
  try {
    return url ? new URL(url).origin : "";
  } catch {
    return "";
  }
}

// Vendor chunking + preload policy for the landing-vs-platform split:
//  - React is an eager entry dependency → its own long-term-cacheable chunk.
//  - MapLibre (~1 MB, an unshrinkable vector-map floor) gets its own chunk too so a code-only deploy
//    doesn't force a re-download — but it is reachable ONLY through the lazily-imported Platform.
//  - resolveDependencies strips MapLibre from the preload graph so Vite does NOT hoist a modulepreload
//    for it into index.html; the signed-out landing therefore never fetches it. It loads on demand when
//    Platform mounts (explore / sign-in). The warning limit reflects MapLibre's real size.
export default defineConfig(({ mode }) => ({
  plugins: [
    appOriginPlugin(originOf(loadEnv(mode, process.cwd(), "VITE_").VITE_APP_URL)),
    react(),
    vendorMaplibrePlugin(),
    prerenderLandingPlugin(webDir),
    serviceWorkerPlugin(),
    noticesPlugin(webDir),
  ],
  server: { proxy: gatewayProxy(process.env.DEV_GATEWAY || "http://127.0.0.1:8787") },
  build: {
    chunkSizeWarningLimit: 1100, // MapLibre's real chunk size (~1.05 MB)
    modulePreload: {
      resolveDependencies: (_url, deps) => deps.filter((d) => !d.includes("maplibre")),
    },
    rollupOptions: {
      output: {
        // Function form (not the object map): Vite 8 bundles with Rolldown, which accepts a
        // manualChunks(id) callback but not the object syntax. MapLibre and React each land in their
        // own long-term-cacheable chunk (scheduler, a react-dom dependency, rides in the react chunk).
        manualChunks(id) {
          if (id.includes("node_modules/maplibre-gl")) return "maplibre";
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "react";
        },
      },
    },
  },
}));
