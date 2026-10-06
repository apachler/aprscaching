// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { sanitizePrefs } from "../src/prefs.js";

describe("account UI-prefs sanitizer", () => {
  it("keeps only known keys and coerces each to a safe shape", () => {
    const out = sanitizePrefs({
      locale: { locale: "de-AT", timeZone: "Europe/Vienna", units: "metric", theme: "dark", junk: 1 },
      pins: ["terminal", "bbs"],
      basemap: "topo",
      evil: "<script>", // unknown key → dropped
    });
    expect(out).toEqual({
      locale: { locale: "de-AT", timeZone: "Europe/Vienna", units: "metric", theme: "dark" },
      pins: ["terminal", "bbs"],
      basemap: "topo",
    });
    expect(out).not.toHaveProperty("evil");
  });

  it("rejects bad enum values but keeps valid siblings", () => {
    const out = sanitizePrefs({ locale: { units: "furlongs", theme: "neon", locale: "en-US" } });
    expect(out.locale).toEqual({ locale: "en-US" }); // units/theme dropped, locale kept
  });

  it("caps pins to strings, ≤20 entries, ≤45 chars each (a tool pin and its name); drops non-arrays", () => {
    const out = sanitizePrefs({ pins: ["a".repeat(60), 5, "bbs", ...Array.from({ length: 30 }, (_, i) => `p${i}`)] });
    const pins = out.pins as string[];
    expect(pins.length).toBe(20);
    expect(pins[0]!.length).toBe(45);
    expect(pins).not.toContain(5 as unknown as string);
    expect(sanitizePrefs({ pins: "nope" }).pins).toBeUndefined();
  });

  it("keeps installed tools as checked records, one per name, and drops malformed ones", () => {
    const key = "uibFUCjcBnxAe8mRQ1v2neJd0fPV_7Vs0Y59K5vH5Oc";
    const good = {
      name: "mheard",
      url: "https://a.example/tools/mheard/tool.json",
      pubkey: key,
      grants: ["monitor", "hack"],
      on: true,
    };
    const out = sanitizePrefs({
      tools: [
        { ...good, via: { id: "builtin", account: false }, extra: 1 },
        { ...good, on: false }, // the same name again
        { ...good, name: "Bad Name" },
        { ...good, name: "js", url: "javascript:alert(1)" },
        { ...good, name: "short-key", pubkey: "abc" },
        "nope",
      ],
    });
    expect(out.tools).toEqual([
      {
        name: "mheard",
        title: "mheard",
        url: good.url,
        pubkey: key,
        grants: ["monitor"],
        connect: [],
        remote: false,
        on: true,
        via: { id: "builtin", account: false },
      },
    ]);
    expect(
      (
        sanitizePrefs({
          tools: [
            { ...good, title: "MHeard", connect: ["https://a.example", "http://b", "https://c/x"], remote: true },
          ],
        }).tools as Record<string, unknown>[]
      )[0],
    ).toMatchObject({ title: "MHeard", connect: ["https://a.example"], remote: true });
  });

  it("returns an empty object for junk / non-object input", () => {
    expect(sanitizePrefs(null)).toEqual({});
    expect(sanitizePrefs("x")).toEqual({});
    expect(sanitizePrefs(42)).toEqual({});
  });
});
