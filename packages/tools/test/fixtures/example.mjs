// SPDX-License-Identifier: MIT
// Reads the example tool under examples/station-log. Plain JS so the package's typecheck needs no Node type
// definitions; the declaration beside it types the result.
import { readFileSync } from "node:fs";

const dir = new URL("../../examples/station-log/", import.meta.url);

export function loadExampleTool() {
  return {
    manifest: JSON.parse(readFileSync(new URL("tool.json", dir), "utf8")),
    script: readFileSync(new URL("tool.js", dir), "utf8"),
  };
}
