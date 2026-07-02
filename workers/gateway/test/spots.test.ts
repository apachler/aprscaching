// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { bandForHz, freqToHz, gridToLatLon, dedupeSpots, filterSpots, type Spot } from "@aprsweb/shared";
import { normalizePota, normalizeGma, normalizeSota, normalizePsk, normalizeDxCluster, normalizeRbn, handleSpots, _resetSpotsCache, _resetSotaSummits } from "../src/spots.js";
import type { Env } from "../src/env.js";

const spot = (p: Partial<Spot>): Spot => ({ id: "x", source: "pota", callsign: "OE8APR", lat: 47, lon: 15, spottedAt: 100, ...p });

describe("spots — band/frequency helpers (S1)", () => {
  it("bandForHz maps HF→VHF, rejects out-of-plan / missing", () => {
    expect(bandForHz(14_250_000)).toBe("20m");
    expect(bandForHz(7_100_000)).toBe("40m");
    expect(bandForHz(145_500_000)).toBe("2m");
    expect(bandForHz(99)).toBeUndefined();
    expect(bandForHz(undefined)).toBeUndefined();
  });
  it("freqToHz disambiguates MHz / kHz / Hz inputs", () => {
    expect(freqToHz("14.250")).toBe(14_250_000); // MHz
    expect(freqToHz("14250")).toBe(14_250_000);  // kHz
    expect(freqToHz(14_250_000)).toBe(14_250_000); // Hz
    expect(freqToHz("")).toBeUndefined();
    expect(freqToHz(null)).toBeUndefined();
  });
});

describe("spots — POTA normalizer (S1)", () => {
  const raw = [
    { spotId: 1, activator: "k1abc", reference: "US-0001", name: "Acadia NP", frequency: "14250", mode: "ssb", latitude: 44.3, longitude: -68.2, spotTime: "2024-06-01T12:00:00Z", comments: "QRT soon" },
    { spotId: 2, activator: "W2XYZ", reference: "US-0002", frequency: "7.030", mode: "CW", latitude: null, longitude: -70 }, // no lat -> dropped
  ];
  it("maps fields, derives band, upper-cases callsign, drops coordless spots", () => {
    const out = normalizePota(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ source: "pota", callsign: "K1ABC", ref: "US-0001", name: "Acadia NP", band: "20m", mode: "SSB", lat: 44.3, lon: -68.2 });
    expect(out[0].freqHz).toBe(14_250_000);
    expect(out[0].spottedAt).toBe(Math.floor(Date.parse("2024-06-01T12:00:00Z") / 1000));
  });
  it("tolerates non-array / junk input", () => {
    expect(normalizePota(null)).toEqual([]);
    expect(normalizePota({})).toEqual([]);
    expect(normalizePota([{ activator: "NOLAT" }])).toEqual([]);
  });
});

describe("spots — GMA normalizer (S3)", () => {
  it("reads the cqgma RCD envelope, derives band, drops coordless spots", () => {
    const raw = { RCD: [
      { ID: "1", DATE: "2024-06-01", TIME: "1230", ACTIVATOR: "oe6sota", NAME: "Schöckl", REF: "BOTA-1", QRG: "14285", MODE: "ssb", LAT: "47.198", LON: "15.466" },
      { ID: "2", ACTIVATOR: "NOCOORD", QRG: "7032", MODE: "CW" },
    ] };
    const out = normalizeGma(raw);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ source: "gma", callsign: "OE6SOTA", ref: "BOTA-1", band: "20m", mode: "SSB", lat: 47.198, lon: 15.466 });
  });
});

describe("spots — SOTA normalizer + summit resolution (S3)", () => {
  it("builds the ref from association+summit and uses inline coords when present (no fetch)", async () => {
    _resetSotaSummits();
    const raw = [{ id: 5, activatorCallsign: "oe6sota", associationCode: "OE", summitCode: "ST-027", frequency: "14.285", mode: "ssb", latitude: 47.198, longitude: 15.466, timeStamp: "2024-06-01T12:30:00Z" }];
    const out = await normalizeSota(raw, {} as Env);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ source: "sota", callsign: "OE6SOTA", ref: "OE/ST-027", band: "20m", lat: 47.198 });
  });

  it("resolves missing coordinates from the summit API (cached)", async () => {
    _resetSotaSummits();
    const orig = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ latitude: 48.1, longitude: 14.0, name: "Test Summit" }), { headers: { "content-type": "application/json" } }); }) as typeof fetch;
    try {
      const raw = [
        { id: 6, activatorCallsign: "OE5XYZ", associationCode: "OE", summitCode: "OO-001", frequency: "7032", mode: "CW", timeStamp: "2024-06-01T08:00:00Z" },
        { id: 7, activatorCallsign: "OE5ABC", associationCode: "OE", summitCode: "OO-001", frequency: "10120", mode: "CW", timeStamp: "2024-06-01T08:05:00Z" },
      ];
      const env = { SPOTS_SOTA_SUMMITS_URL: "http://stub/summits/" } as unknown as Env;
      const out = await normalizeSota(raw, env);
      expect(out).toHaveLength(2);
      expect(out[0]).toMatchObject({ ref: "OE/OO-001", lat: 48.1, lon: 14.0, name: "Test Summit" });
      expect(calls).toBe(1); // second spot hits the per-summit cache
    } finally { globalThis.fetch = orig; }
  });
});

describe("spots — reception networks (S3): grid + PSK/DX/RBN", () => {
  it("gridToLatLon returns the square centre and rejects junk", () => {
    expect(gridToLatLon("JN88")).toEqual({ lat: 48.5, lon: 17 });
    expect(gridToLatLon("jn77")).toEqual({ lat: 47.5, lon: 15 });
    expect(gridToLatLon("ZZ99")).toBeNull();
    expect(gridToLatLon("")).toBeNull();
    const sub = gridToLatLon("JN88ec")!;
    expect(sub.lat).toBeGreaterThan(48); expect(sub.lat).toBeLessThan(49);
  });

  it("normalizePsk maps the sender locator to coordinates, drops gridless reports", () => {
    const out = normalizePsk({ receptionReport: [
      { senderCallsign: "oe8apr", senderLocator: "JN77", frequency: "14074000", mode: "FT8", flowStartSeconds: 1717236000 },
      { senderCallsign: "NOGRID", frequency: "7074000", mode: "FT8" },
    ] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ source: "pskreporter", callsign: "OE8APR", band: "20m", mode: "FT8", lat: 47.5, lon: 15 });
  });

  it("normalizeDxCluster / normalizeRbn map only when a grid is present", () => {
    const dx = normalizeDxCluster([
      { dx: "DL1ABC", frequency: "14250", grid: "JO31", time: 1717236000, comment: "up 2" },
      { dx: "NOLOC", frequency: "7032" },
    ]);
    expect(dx).toHaveLength(1);
    expect(dx[0]).toMatchObject({ source: "dxcluster", callsign: "DL1ABC", band: "20m" });
    const rbn = normalizeRbn([{ dx: "OE8APR", freq: "7030", grid: "JN77", snr: "25", mode: "CW" }]);
    expect(rbn[0]).toMatchObject({ source: "rbn", callsign: "OE8APR", band: "40m", comment: "RBN 25 dB" });
  });
});

describe("spots — dedupe + filter (S1)", () => {
  it("dedupeSpots keeps the newest record per callsign+ref+band across sources", () => {
    const older = spot({ id: "a", source: "pota", ref: "US-1", band: "20m", spottedAt: 100 });
    const newer = spot({ id: "b", source: "sota", ref: "US-1", band: "20m", spottedAt: 200 });
    const other = spot({ id: "c", ref: "US-2", band: "40m", spottedAt: 150 });
    const out = dedupeSpots([older, newer, other]);
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe("b"); // newest first
    expect(out.find((s) => s.ref === "US-1")!.id).toBe("b");
  });
  it("filterSpots honours bbox, bands, modes, sources", () => {
    const inBox = spot({ id: "in", lat: 47, lon: 15, band: "20m", mode: "SSB", source: "pota" });
    const outBox = spot({ id: "out", lat: 10, lon: 10, band: "20m", mode: "SSB", source: "pota" });
    const all = [inBox, outBox, spot({ id: "fm", lat: 47, lon: 15, band: "2m", mode: "FM", source: "gma" })];
    expect(filterSpots(all, { bbox: [14, 46, 16, 48] }).map((s) => s.id).sort()).toEqual(["fm", "in"]);
    expect(filterSpots(all, { bands: ["20m"] }).map((s) => s.id).sort()).toEqual(["in", "out"]);
    expect(filterSpots(all, { modes: ["fm"] }).map((s) => s.id)).toEqual(["fm"]);
    expect(filterSpots(all, { sources: ["pota"] }).map((s) => s.id).sort()).toEqual(["in", "out"]);
  });
});

describe("spots — endpoint disabled by default (S1)", () => {
  it("GET /api/spots returns enabled:false + no spots and makes no outbound call", async () => {
    _resetSpotsCache();
    const res = await handleSpots(new Request("https://api.example/api/spots"), {} as Env);
    const data = await res.json() as any;
    expect(data.enabled).toBe(false);
    expect(data.spots).toEqual([]);
    expect(data.count).toBe(0);
  });
});
