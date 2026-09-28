// SPDX-License-Identifier: MIT
// Loads the MeshCom golden fixtures from this directory. Plain JS so the library's typecheck needs no
// Node type definitions; the declaration beside it types the result.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));

export function loadMeshcomFixtures() {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ name: f.replace(/\.json$/, ""), ...JSON.parse(readFileSync(join(dir, f), "utf8")) }));
}
