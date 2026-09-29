// SPDX-License-Identifier: AGPL-3.0-or-later
// isGatewayPath is how a server that also serves the SPA (the desktop app) tells gateway routes from
// app routes. It must claim every route the router handles — read here from app.ts itself, so a new
// route cannot be missed — and nothing the SPA serves.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isGatewayPath } from "../src/app.js";

const src = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
const literal = [...src.matchAll(/p === "(\/[^"]*)"/g)].map((m) => m[1]!);
const prefixed = [...src.matchAll(/p\.startsWith\("(\/[^"]*)"\)/g)].map((m) => `${m[1]!}x`);
// segment routes: `/^\/api\/views\/([a-z0-9]+)$/` → the literal lead before the first group
const segment = [...src.matchAll(/= \/\^((?:\\\/[A-Za-z0-9._-]+)+)/g)].map((m) => `${m[1]!.replace(/\\\//g, "/")}/x`);

describe("isGatewayPath", () => {
  it("claims every route app.ts handles", () => {
    expect(literal.length).toBeGreaterThan(100);
    expect(segment.length).toBeGreaterThan(20);
    for (const p of [...literal, ...prefixed, ...segment]) expect(isGatewayPath(p), p).toBe(true);
  });

  it("leaves the SPA its own paths", () => {
    for (const p of ["/", "/index.html", "/assets/index-abc.js", "/manifest.webmanifest", "/sw.js", "/map", "/shack"])
      expect(isGatewayPath(p), p).toBe(false);
    expect(isGatewayPath("/apiary")).toBe(false);
    expect(isGatewayPath("/verify-help")).toBe(false);
  });
});
