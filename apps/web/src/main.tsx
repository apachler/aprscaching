// SPDX-License-Identifier: AGPL-3.0-or-later
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ErrorBoundary } from "./ui/index.js";
import { loadSettings, resolveTheme, resolveCrt, makeFormatters, FormatContext } from "./format.js";
import { registerServiceWorker } from "./shell/serviceWorker.js";

// The offline app shell (public/sw.js). Development serves unhashed modules, so there is nothing to store.
if (import.meta.env.PROD) void registerServiceWorker();

// Apply the saved theme to <html> before first paint so a Phosphor user doesn't flash the modern
// palette while the (lazily-loaded) Platform mounts.
{
  const saved = loadSettings();
  document.documentElement.dataset.theme = resolveTheme(saved.theme);
  document.documentElement.dataset.crt = resolveCrt(saved);
}

const root = createRoot(document.getElementById("root")!);
// `/?demo=packet|bbs|1` mounts the hardware-free design harness (real components + in-process simulator)
// instead of the app — a durable bench for the packet/BBS shells (and the Phosphor terminal look).
const params = new URLSearchParams(location.search);
const demo = params.get("demo");
if (demo === "app") {
  // the whole app against canned gateway answers (demo/fixtures.ts): the design review's and the visual
  // harness's bench. `&as=user|sysop|out` picks who is signed in.
  // `&scale=role` previews the role scales on the real surfaces (styles/scale-preview.css)
  const preview = params.get("scale") === "role" ? import("./styles/scale-preview.css") : Promise.resolve();
  Promise.all([import("./demo/fixtures.js"), preview]).then(([{ installAppFixtures }]) => {
    if (params.get("scale") === "role") document.documentElement.dataset.scale = "role";
    // `&theme=dark|light|phosphor` holds the token attribute on the theme asked for (the UI kit's frames)
    const theme = params.get("theme");
    if (theme === "dark" || theme === "light" || theme === "phosphor") {
      const html = document.documentElement;
      const hold = () => {
        if (html.dataset.theme !== theme) html.dataset.theme = theme;
      };
      hold();
      new MutationObserver(hold).observe(html, { attributes: true, attributeFilter: ["data-theme"] });
    }
    const as = params.get("as");
    installAppFixtures(as === "sysop" || as === "out" ? as : "user");
    root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>,
    );
  });
} else if (demo === "ui") {
  // the UI kit: tokens, role scales and every primitive in every state (demo/UiKit.tsx)
  import("./demo/UiKit.js").then(({ UiKit }) =>
    root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <UiKit />
        </ErrorBoundary>
      </React.StrictMode>,
    ),
  );
} else if (demo) {
  // the harness renders components directly (no Platform), so provide the format/theme context Ico needs
  import("./demo/DemoHarness.js").then(({ DemoHarness }) =>
    root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <FormatContext.Provider value={makeFormatters(loadSettings())}>
            <DemoHarness which={demo} />
          </FormatContext.Provider>
        </ErrorBoundary>
      </React.StrictMode>,
    ),
  );
} else {
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}
