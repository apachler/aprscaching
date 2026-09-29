// SPDX-License-Identifier: AGPL-3.0-or-later
// Grouped settings: retention, supporter links and the reception-network spot endpoints are each one
// JSON setting with code defaults, and the self-host servers forward exactly the settings Env declares.
import { describe, it, expect, afterEach, vi } from "vitest";
import { stringEnvFrom, type Env } from "../src/env.js";
import { retentionFrom, RETENTION_DEFAULTS } from "../src/retention.js";
import { supportLinks } from "../src/support.js";
import { getSpots, _resetSpotsCache } from "../src/spots.js";

const env = (o: Record<string, string>) => o as unknown as Env;

describe("RETENTION", () => {
  it("defaults every table when unset", () => {
    expect(retentionFrom(env({}))).toEqual(RETENTION_DEFAULTS);
    expect(RETENTION_DEFAULTS).toEqual({
      packetsHours: 24,
      messagesDays: 7,
      sensorDays: 30,
      portStatsDays: 7,
      alertsDays: 30,
      mheardDays: 7,
    });
  });

  it("overrides only the tables it names", () => {
    const r = retentionFrom(env({ RETENTION: '{"packetsHours":6,"sensorDays":90}' }));
    expect(r).toEqual({ ...RETENTION_DEFAULTS, packetsHours: 6, sensorDays: 90 });
  });

  it("ignores malformed JSON and non-positive or non-numeric values", () => {
    expect(retentionFrom(env({ RETENTION: "{nope" }))).toEqual(RETENTION_DEFAULTS);
    expect(retentionFrom(env({ RETENTION: "[1,2]" }))).toEqual(RETENTION_DEFAULTS);
    expect(
      retentionFrom(env({ RETENTION: '{"packetsHours":0,"messagesDays":-3,"sensorDays":"x","alertsDays":null}' })),
    ).toEqual(RETENTION_DEFAULTS);
  });
});

describe("SUPPORT_LINKS", () => {
  it("is empty when unset or malformed", () => {
    expect(supportLinks(env({}))).toEqual([]);
    expect(supportLinks(env({ SUPPORT_LINKS: "not json" }))).toEqual([]);
    expect(supportLinks(env({ SUPPORT_LINKS: '{"label":"x"}' }))).toEqual([]);
  });

  it("surfaces labelled http(s) links in order and drops the rest", () => {
    const links = supportLinks(
      env({
        SUPPORT_LINKS: JSON.stringify([
          { label: "Liberapay", url: "https://liberapay.com/example" },
          { label: "", url: "https://example.org/blank-label" },
          { label: "Script", url: "javascript:alert(1)" },
          { label: "Ko-fi", url: "https://ko-fi.com/example" },
          { url: "https://example.org/no-label" },
        ]),
      }),
    );
    expect(links).toEqual([
      { label: "Liberapay", url: "https://liberapay.com/example" },
      { label: "Ko-fi", url: "https://ko-fi.com/example" },
    ]);
  });
});

describe("SPOTS_RECEPTION_URLS", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    _resetSpotsCache();
  });

  const polled = async (settings: Record<string, string>) => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (u: RequestInfo | URL) => {
      urls.push(String(u));
      return Response.json([]);
    });
    _resetSpotsCache();
    await getSpots(env({ SPOTS_ENABLED: "1", ...settings }));
    return urls;
  };

  it("polls a reception network only when its endpoint is configured", async () => {
    expect(await polled({ SPOTS_SOURCES: "pskreporter,rbn" })).toEqual([]);
    expect(
      await polled({ SPOTS_SOURCES: "pskreporter,rbn", SPOTS_RECEPTION_URLS: '{"rbn":"https://rbn.example/spots"}' }),
    ).toEqual(["https://rbn.example/spots"]);
  });

  it("polls the built-in activity sources at their fixed endpoints", async () => {
    expect(await polled({ SPOTS_SOURCES: "pota" })).toEqual(["https://api.pota.app/spot/activator"]);
  });
});

describe("stringEnvFrom", () => {
  it("forwards the grouped settings and nothing that Env does not declare", () => {
    const out = stringEnvFrom({
      RETENTION: "{}",
      SUPPORT_LINKS: "[]",
      SPOTS_RECEPTION_URLS: "{}",
      DOH_URL: "https://dns.example/dns-query",
      ADMIN_CALLSIGNS: "OE8APR",
      PACKETS_TTL_HOURS: "6",
      SUPPORT_KOFI: "https://ko-fi.com/x",
      SPOTS_POTA_URL: "https://pota.example",
      FED_CORROBORATION_GRID_DEG: "1",
      COT_STREAM_MAX_MS: "1000",
      API_MAX_BBOX_DEG: "90",
      UNRELATED: "x",
    });
    expect(Object.keys(out).sort()).toEqual(
      ["ADMIN_CALLSIGNS", "DOH_URL", "RETENTION", "SPOTS_RECEPTION_URLS", "SUPPORT_LINKS"].sort(),
    );
  });
});
