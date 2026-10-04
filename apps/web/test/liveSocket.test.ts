// SPDX-License-Identifier: AGPL-3.0-or-later
// The live socket's URL is absolute: an API on the page's own origin (an empty API base) resolves against the page.
import { describe, it, expect } from "vitest";
import { liveSocketUrl } from "../src/platform/useLiveSocket.js";

describe("the live socket URL", () => {
  it("takes the page's origin when the API base is empty", () => {
    expect(liveSocketUrl("", { href: "https://aprscaching.net/?cache=AC-1" })).toBe(
      "wss://aprscaching.net/ws?region=global",
    );
    expect(liveSocketUrl("", { href: "http://localhost:5173/" })).toBe("ws://localhost:5173/ws?region=global");
  });
  it("takes the API's own host when one is set", () => {
    expect(liveSocketUrl("https://api.aprscaching.net", { href: "https://aprscaching.net/" })).toBe(
      "wss://api.aprscaching.net/ws?region=global",
    );
    expect(liveSocketUrl("http://192.168.1.5:8787", { href: "https://x.test/" })).toBe(
      "ws://192.168.1.5:8787/ws?region=global",
    );
  });
});
