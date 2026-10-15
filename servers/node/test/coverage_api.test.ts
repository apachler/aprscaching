// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/v1/coverage: the receivers the hide form's map draws as range circles. Attested receiving sites stand
// apart from the digipeaters and IGates heard on the air; an advertised PHG or RNG is drawn as sent, a station
// without one gets the conservative default for its kind, marked estimated; nothing outside the box, nothing
// long silent, no plain station and no owner is named.
import { describe, it, expect } from "vitest";
import { authEnv, call } from "./helpers/authflow.js";
import { COVERAGE_DEFAULT_KM, COVERAGE_MAX_KM, CoverageResponse } from "@aprscaching/shared";

const SECRET = { "x-ingest-secret": "test-ingest-secret" };
const now = () => Math.floor(Date.now() / 1000);
const BBOX = "15.0,46.8,16.0,47.4";

async function station(
  e: ReturnType<typeof authEnv>,
  call: string,
  o: { lat?: number; lon?: number; symbol?: string | null; range?: number | null; ago?: number; via?: string } = {},
) {
  await e.DB.prepare(
    "INSERT INTO stations (callsign, lat, lon, symbol, range_km, last_seen, source_call) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(call, o.lat ?? 47.07, o.lon ?? 15.44, o.symbol ?? "/>", o.range ?? null, now() - (o.ago ?? 60), o.via ?? null)
    .run();
}

/** The live fan-out the ingest posts to, answered and dropped. */
const ROOMS = { get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) };

async function seed() {
  const e = authEnv({ FIRST_PARTY_SITES: "OE6XGR-10", ROOMS });
  // a digipeater advertising its PHG, through the ingest
  const r = await call(
    e,
    "POST",
    "/ingest",
    {
      packets: [
        {
          src: "OE6XRR-3",
          dst: "APN391",
          path: [],
          payload: "!4705.00N/01530.00E#PHG5360/Schoeckl digipeater",
          kind: "position",
          heardVia: "rf",
          port: "aprs-is",
          ts: now() - 30,
        },
      ],
    },
    SECRET,
  );
  expect(r.status).toBe(200);
  await station(e, "OE6XGR-10", { symbol: "I&", ago: 20 * 86400 }); // the attested site, beaconing seldom
  await station(e, "OE6IGT", { symbol: "R&", range: 400 }); // an RX IGate advertising more than the cap
  await station(e, "OE6WID", { symbol: "S#" }); // an overlay digipeater, no PHG
  await station(e, "OE6GATE", { symbol: "/-" }); // a home station that gates others
  await station(e, "OE6MOB-9", { symbol: "/>", via: "OE6GATE" }); // a mobile: not a receiver
  await station(e, "OE6REG", { symbol: "/-" }); // a registered digipeater
  await e.DB.prepare(
    "INSERT INTO account_stations (account_id, callsign, lat, lon, roles, created_at, updated_at) VALUES ('acct-1', 'OE6REG', 1, 1, 'digipeater', 1, 1)",
  ).run();
  await station(e, "OE6OLD", { symbol: "/#", ago: 10 * 86400 }); // a digipeater silent for 10 days
  await station(e, "DL1FAR", { symbol: "/#", lat: 48.5, lon: 11.5 }); // outside the box
  return e;
}

describe("GET /api/v1/coverage", () => {
  it("answers the receivers in the box with their ranges, the attested site apart", async () => {
    const e = await seed();
    const r = await call(e, "GET", `/api/v1/coverage?bbox=${BBOX}`);
    expect(r.status).toBe(200);
    const body = CoverageResponse.parse(r.data);
    expect(body.truncated).toBe(false);
    const by = Object.fromEntries(body.sites.map((s) => [s.callsign, s]));
    expect(Object.keys(by).sort()).toEqual(["OE6GATE", "OE6IGT", "OE6REG", "OE6WID", "OE6XGR-10", "OE6XRR-3"]);
    expect(by["OE6XGR-10"]).toMatchObject({
      kind: "attested",
      rangeKm: COVERAGE_DEFAULT_KM.receiver,
      estimated: true,
    });
    expect(by["OE6XRR-3"]!.kind).toBe("digipeater");
    expect(by["OE6XRR-3"]!.estimated).toBe(false);
    expect(by["OE6XRR-3"]!.rangeKm).toBeGreaterThan(10);
    expect(by["OE6IGT"]).toMatchObject({ kind: "igate", rangeKm: COVERAGE_MAX_KM, estimated: false });
    expect(by["OE6WID"]).toMatchObject({
      kind: "digipeater",
      rangeKm: COVERAGE_DEFAULT_KM.digipeater,
      estimated: true,
    });
    expect(by["OE6GATE"]).toMatchObject({ kind: "igate", estimated: true });
    expect(by["OE6REG"]!.kind).toBe("digipeater");
    // nothing of the registry beyond what the station sent on the air
    expect(JSON.stringify(body)).not.toContain("acct-1");
    expect(by["OE6REG"]!.lat).toBe(47.07);
  });

  it("refuses a missing or oversized box, and is listed in the API index", async () => {
    const e = await seed();
    expect((await call(e, "GET", "/api/v1/coverage")).status).toBe(400);
    expect((await call(e, "GET", "/api/v1/coverage?bbox=0,0,30,30")).status).toBe(400);
    const idx = await call(e, "GET", "/api/v1");
    expect(idx.data.endpoints.map((p: { path: string }) => p.path)).toContain("/api/v1/coverage?bbox=");
  });

  it("has no attested sites to draw when the instance attests none", async () => {
    const e = await seed();
    const plain = authEnv({}, e.DB);
    const r = await call(plain, "GET", `/api/v1/coverage?bbox=${BBOX}`);
    const kinds = (r.data as CoverageResponse).sites.map((s) => s.kind);
    expect(kinds).not.toContain("attested");
    // unattested, the site counts only as an IGate heard lately, and it last beaconed 20 days ago
    expect((r.data as CoverageResponse).sites.find((s) => s.callsign === "OE6XGR-10")).toBeUndefined();
  });
});
