// SPDX-License-Identifier: AGPL-3.0-or-later
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { loadSettings, resolveTheme, resolveCrt, makeFormatters, FormatContext } from "./format.js";

// Apply the saved theme to <html> before first paint so a Phosphor user doesn't flash the modern
// palette while the (lazily-loaded) Platform mounts.
{
  const saved = loadSettings();
  document.documentElement.dataset.theme = resolveTheme(saved.theme);
  document.documentElement.dataset.crt = resolveCrt(saved);
}

const root = createRoot(document.getElementById("root")!);
// `/?demo=packet|bbs|1` mounts the hardware-free design harness (real components + in-process simulator)
// instead of the app — a durable bench for the packet/BBS shells (and the Stage-3 Phosphor flip).
const demo = new URLSearchParams(location.search).get("demo");
if (demo) {
  // the harness renders components directly (no Platform), so provide the format/theme context Ico needs
  import("./demo/DemoHarness.js").then(({ DemoHarness }) =>
    root.render(
      <React.StrictMode>
        <FormatContext.Provider value={makeFormatters(loadSettings())}>
          <DemoHarness which={demo} />
        </FormatContext.Provider>
      </React.StrictMode>,
    ),
  );
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
