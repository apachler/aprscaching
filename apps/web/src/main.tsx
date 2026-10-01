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
const demo = new URLSearchParams(location.search).get("demo");
if (demo) {
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
