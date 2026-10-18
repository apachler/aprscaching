// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The vendored copy is what build.sh compiles into the shipped WebAssembly, so it must be exactly the files
// SHA256SUMS lists (CI checks that list against the upstream tag): an edited, added or dropped file fails here.
const VENDOR = fileURLToPath(new URL("../vendor/direwolf/", import.meta.url));
const OWN = new Set(["SHA256SUMS", "UPSTREAM"]);

function listed(): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of readFileSync(join(VENDOR, "SHA256SUMS"), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!m) throw new Error(`SHA256SUMS: unreadable line ${JSON.stringify(line)}`);
    sums.set(m[2]!, m[1]!);
  }
  return sums;
}

function vendored(dir = VENDOR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return vendored(path);
    const rel = relative(VENDOR, path);
    return OWN.has(rel) ? [] : [rel];
  });
}

describe("vendored Direwolf", () => {
  it("holds exactly the files SHA256SUMS lists", () => {
    const sums = listed();
    expect(sums.size).toBeGreaterThan(0);
    expect(vendored().sort()).toEqual([...sums.keys()].sort());
  });

  it("matches SHA256SUMS byte for byte", () => {
    const sums = listed();
    const wrong = [...sums].filter(
      ([file, sum]) =>
        createHash("sha256")
          .update(readFileSync(join(VENDOR, file)))
          .digest("hex") !== sum,
    );
    expect(wrong.map(([file]) => file)).toEqual([]);
  });
});
