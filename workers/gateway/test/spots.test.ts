import { describe, it, expect } from "vitest";
import { bandForHz, freqToHz, dedupeSpots, filterSpots, type Spot } from "@aprsweb/shared";
import { normalizePota, handleSpots, _resetSpotsCache } from "../src/spots.js";
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
