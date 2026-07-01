import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

const root = createRoot(document.getElementById("root")!);
// `/?demo=packet|bbs|1` mounts the hardware-free design harness (real components + in-process simulator)
// instead of the app — a durable bench for the packet/BBS shells (and the Stage-3 Cogmind flip).
const demo = new URLSearchParams(location.search).get("demo");
if (demo) {
  import("./demo/DemoHarness.js").then(({ DemoHarness }) =>
    root.render(<React.StrictMode><DemoHarness which={demo} /></React.StrictMode>));
} else {
  root.render(<React.StrictMode><App /></React.StrictMode>);
}
