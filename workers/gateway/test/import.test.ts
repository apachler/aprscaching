// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, afterEach } from "vitest";
import { parseCsv, parseGeoJsonFeatures, parseGpxWaypoints } from "../src/import/parse.js";
import { SOURCES } from "../src/import/sources.js";
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
