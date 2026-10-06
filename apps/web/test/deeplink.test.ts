// SPDX-License-Identifier: AGPL-3.0-or-later
// A cache's share link (`/?cache=AC-0001`, from Copy link, the printed QR, the embed, the feeds and the sysop's
// reports) opens the platform on that cache, signed in or not, and leaves the address once it is read.
import { describe, expect, it } from "vitest";
import { cacheFromQuery, opensPlatform } from "../src/deeplink.js";
import { viewQuery, panel, MAP } from "../src/nav.js";

describe("cache share links", () => {
  it("name the cache, upper-cased", () => {
    expect(cacheFromQuery("?cache=AC-0001")).toBe("AC-0001");
    expect(cacheFromQuery("?cache=ac-0042")).toBe("AC-0042");
    expect(cacheFromQuery("?cache=%20AC-7%20")).toBe("AC-7");
  });

  it("ignore what is not a cache code", () => {
    expect(cacheFromQuery("")).toBeNull();
    expect(cacheFromQuery("?cache=")).toBeNull();
    expect(cacheFromQuery("?cache=%3Cscript%3E")).toBeNull();
    expect(cacheFromQuery("?cache=-AC")).toBeNull();
  });

  it("open the platform, so a visitor who scanned the QR sees the cache and not the landing", () => {
    expect(opensPlatform("?cache=AC-0001")).toBe(true);
    expect(opensPlatform("?view=nearby")).toBe(true);
    expect(opensPlatform("?v=abc123")).toBe(true);
    expect(opensPlatform("")).toBe(false);
    expect(opensPlatform("?cache=%3Cb%3E")).toBe(false);
  });

  it("leave the address at the first history sync, keeping the rest of the query", () => {
    expect(viewQuery(MAP, "?cache=AC-0001")).toBe("");
    expect(viewQuery(panel("nearby"), "?cache=AC-0001&lang=de")).toBe("?lang=de&view=nearby");
  });
});
