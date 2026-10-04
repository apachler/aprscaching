// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import { htmlToAttribution, parseCsv, parseGeoJsonFeatures, parseGpxWaypoints } from "../src/import/parse.js";
import { SOURCES, importerUserAgent } from "../src/import/sources.js";
import { ImportNotPermitted, importBlocked, runImport } from "../src/import/engine.js";
import { APP_VERSION } from "../src/version.js";
import type { Env } from "../src/env.js";

describe("CSV parser", () => {
  it("parses headers + rows, honoring quotes and embedded commas", () => {
    const csv = `reference,name,latitude,longitude\nUS-0001,"Acadia, NP",44.35,-68.21\nUS-0002,Zion,37.3,-113.0\n`;
    const { header, rows } = parseCsv(csv);
    expect(header).toEqual(["reference", "name", "latitude", "longitude"]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.name).toBe("Acadia, NP"); // quoted comma preserved
    expect(rows[0]!.reference).toBe("US-0001");
    expect(rows[1]!.latitude).toBe("37.3");
  });

  it("skips a banner line (SOTA's summitslist.csv quirk)", () => {
    const csv = `SOTA Summits List 2026-06-01\nSummitCode,SummitName,Latitude,Longitude\nGM/SI-001,Ben More,56.3,-6.0\n`;
    const { header, rows } = parseCsv(csv, { skipLines: 1 });
    expect(header[0]).toBe("SummitCode");
    expect(rows[0]!.SummitName).toBe("Ben More");
  });
});

describe("GeoJSON parser", () => {
  it("extracts Point features with props", () => {
    const gj = JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [15.42, 47.07] },
          properties: { reference: "B/G-0123", name: "Bunker" },
        },
        { type: "Feature", geometry: { type: "LineString", coordinates: [] }, properties: {} }, // ignored
      ],
    });
    const feats = parseGeoJsonFeatures(gj);
    expect(feats).toHaveLength(1);
    expect(feats[0]).toMatchObject({ lat: 47.07, lon: 15.42 });
    expect(feats[0]!.props.reference).toBe("B/G-0123");
  });
});

describe("GPX parser", () => {
  it("reads waypoints with lat/lon and child tags", () => {
    const gpx =
      `<gpx><wpt lat="-37.8" lon="144.9"><name>GA1234</name><urlname>Flagstaff Hill</urlname>` +
      `<type>Geocache|Traditional Cache</type><url>https://geocaching.com.au/cache/GA1234</url></wpt></gpx>`;
    const wpts = parseGpxWaypoints(gpx);
    expect(wpts).toHaveLength(1);
    expect(wpts[0]).toMatchObject({ lat: -37.8, lon: 144.9, name: "GA1234", urlname: "Flagstaff Hill" });
    expect(wpts[0]!.type).toContain("Traditional");
  });
});

describe("GeoJSON importer coerces arbitrary properties (no [object Object] externalId)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const stubFetch = (body: string) => {
    globalThis.fetch = (async () => ({ ok: true, status: 200, text: async () => body })) as typeof fetch;
  };
  const feat = (props: Record<string, unknown>) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [15.42, 47.07] },
    properties: props,
  });
  const fc = (features: unknown[]) => JSON.stringify({ type: "FeatureCollection", features });

  it("falls a non-scalar reference/id back to the per-feature index instead of colliding", async () => {
    stubFetch(
      fc([
        feat({ reference: { nested: 1 }, name: { x: 1 } }), // object ref + object name
        feat({ reference: ["a", "b"] }), // array ref
        feat({ reference: "WCA-0001", name: "Real Castle" }), // clean scalar
      ]),
    );
    const out = await SOURCES.geojson.load({} as Env, { url: "https://example/data.geojson" });
    const ids = out.map((c) => c.externalId);
    expect(ids).not.toContain("[object Object]");
    expect(new Set(ids).size).toBe(ids.length); // every externalId is unique — no clobbering
    expect(out[0]!.externalId).toBe("0"); // object ref → index fallback
    expect(out[0]!.title).toBe("0"); // object name → ref fallback (the index)
    expect(out[2]!.externalId).toBe("WCA-0001"); // a real scalar reference is preserved
    expect(out[2]!.title).toBe("Real Castle");
  });
});

describe("attribution notes keep text and http(s) links only", () => {
  it("turns OKAPI's HTML note into text runs with its links", () => {
    const note =
      "<p>&copy; <a href='https://www.opencaching.de/viewprofile.php?userid=7'>waldläufer</a>, " +
      '<a href="https://www.opencaching.de/">Opencaching.de</a>, ' +
      '<a href="https://creativecommons.org/licenses/by-nc-nd/3.0/de/">CC BY-NC-ND</a>, Stand: 04.10.2026</p>';
    expect(htmlToAttribution(note)).toEqual([
      { text: "© " },
      { text: "waldläufer", href: "https://www.opencaching.de/viewprofile.php?userid=7" },
      { text: ", " },
      { text: "Opencaching.de", href: "https://www.opencaching.de/" },
      { text: ", " },
      { text: "CC BY-NC-ND", href: "https://creativecommons.org/licenses/by-nc-nd/3.0/de/" },
      { text: ", Stand: 04.10.2026" },
    ]);
  });

  it("drops markup and any link that is not http(s), keeping its text", () => {
    const parts = htmlToAttribution(
      '<b>Note</b> <a href="javascript:alert(1)">click</a> <img src=x onerror=alert(1)><script>x</script>',
    );
    expect(parts.every((p) => !p.href)).toBe(true);
    expect(parts.map((p) => p.text).join("")).toBe("Note click x");
  });

  it("yields nothing for an empty or non-string note, and bounds a long one", () => {
    expect(htmlToAttribution("")).toEqual([]);
    expect(htmlToAttribution("<p> </p>")).toEqual([]);
    expect(htmlToAttribution(null)).toEqual([]);
    const long = htmlToAttribution("x".repeat(5000));
    expect(long.map((p) => p.text).join("").length).toBe(1000);
  });
});

describe("OpenCaching import keeps the owner and attribution note", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("asks OKAPI for owner + attribution_note and maps them", async () => {
    const urls: string[] = [];
    const agents: string[] = [];
    globalThis.fetch = (async (u: string, init?: RequestInit) => {
      urls.push(String(u));
      agents.push(new Headers(init?.headers).get("user-agent") ?? "");
      if (String(u).includes("/search/bbox")) return new Response(JSON.stringify({ results: ["OC1234"] }));
      return new Response(
        JSON.stringify({
          OC1234: {
            code: "OC1234",
            name: "Am Schlossberg",
            location: "47.2|15.2",
            type: "Traditional",
            status: "Available",
            url: "https://www.opencaching.de/OC1234",
            owner: { uuid: "u", username: "waldlaeufer", profile_url: "https://www.opencaching.de/viewprofile.php" },
            attribution_note: '© waldlaeufer, <a href="https://www.opencaching.de/">Opencaching.de</a>',
          },
        }),
      );
    }) as typeof fetch;
    const env = { OKAPI_BASE: "https://www.opencaching.de", OKAPI_KEY: "k", INSTANCE: "oc.example" } as Env;
    const [c] = await SOURCES.opencaching!.load(env, { bbox: [15, 47, 16, 48] });
    expect(urls[1]).toContain("fields=code|name|location|type|status|url|owner|attribution_note");
    expect(c).toMatchObject({
      ownerCall: "OC",
      sourceOwner: "waldlaeufer",
      sourceUrl: "https://www.opencaching.de/OC1234",
      sourceAttribution: [{ text: "© waldlaeufer, " }, { text: "Opencaching.de", href: "https://www.opencaching.de/" }],
    });
    expect(agents).toEqual([importerUserAgent(env), importerUserAgent(env)]);
  });
});

describe("importer User-Agent", () => {
  it("names the release, the instance and the operator's email", () => {
    const ua = importerUserAgent({ INSTANCE: "aprs.example.net", OPERATOR_EMAIL: "op@example.net" } as Env);
    expect(ua).toBe(`aprscaching/${APP_VERSION} (+https://aprs.example.net; op@example.net)`);
  });

  it("leaves the email out when none is set", () => {
    expect(importerUserAgent({ INSTANCE: "aprs.example.net" } as Env)).toBe(
      `aprscaching/${APP_VERSION} (+https://aprs.example.net)`,
    );
  });
});

describe("sources that need the provider's permission", () => {
  it("block WWFF, IOTA and Geocaching Australia until IMPORT_ALLOW names them", () => {
    for (const id of ["wwff", "iota", "gcau"]) {
      expect(importBlocked({} as Env, id)).toContain("IMPORT_ALLOW");
      expect(importBlocked({ IMPORT_ALLOW: `sota,${id.toUpperCase()}` } as Env, id)).toBeNull();
    }
    expect(importBlocked({} as Env, "sota")).toBeNull();
    expect(importBlocked({} as Env, "opencaching")).toBeNull();
  });

  it("refuses before any request goes out", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response("");
    }) as typeof fetch;
    try {
      await expect(runImport({} as Env, "iota", {})).rejects.toBeInstanceOf(ImportNotPermitted);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
