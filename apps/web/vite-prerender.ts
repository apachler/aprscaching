// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The landing page as HTML in index.html, so a signed-out visitor sees it before the app's JavaScript has
 * loaded and run: on a slow phone that script is most of the wait. At build time the landing is rendered once
 * (src/landingPrerender.tsx, through a throwaway Vite server in SSR mode) and placed beside #root as
 * #landing-pre. index.html's head script hides it for anyone who will not see the landing; the app takes over
 * from it when its own landing renders (App.tsx). It runs before the service worker's precache list is
 * hashed, which therefore covers the page as served.
 */
import path from "node:path";
import { createServer, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const MARK = '<div id="root"></div>';

export function prerenderLandingPlugin(webDir: string): Plugin {
  return {
    name: "acs-prerender-landing",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      async handler(html) {
        if (!html.includes(MARK)) throw new Error(`index.html has no ${MARK} for the prerendered landing`);
        const server = await createServer({
          root: webDir,
          configFile: false,
          logLevel: "error",
          plugins: [react()],
          server: { middlewareMode: true, hmr: false, watch: null },
          appType: "custom",
          optimizeDeps: { noDiscovery: true, include: [] },
        });
        try {
          const mod = (await server.ssrLoadModule(path.join(webDir, "src/landingPrerender.tsx"))) as {
            render: () => string;
          };
          return html.replace(MARK, `${MARK}\n    <div id="landing-pre">${mod.render()}</div>`);
        } finally {
          await server.close();
        }
      },
    },
  };
}
