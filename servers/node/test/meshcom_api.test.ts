// SPDX-License-Identifier: AGPL-3.0-or-later
// The MeshCom read API behind the map layer: nodes and links with a known position, filtered by the map's
// box, bounded in size, and with exact battery and signal figures only for signed-in members.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup } from "./helpers/authflow.js";
import type { Env } from "@aprscaching/gateway/env";

const RX = "OE8APR-12";
const SECRET = { "x-ingest-secret": "test-ingest-secret" };
const now = () => Math.floor(Date.now() / 1000) - 60;

function env(): Env {
  const room = { fetch: async () => new Response(null, { status: 204 }) };
  return authEnv({ ROOMS: { idFromName: (n: string) => n, get: () => room } });
}

/** A MeshCom position packet at (lat, lon) with the ingest's metadata. */
const pkt = (src: string, lat: number, lon: number, meta: Record<string, unknown>) => {
  const dm = (v: number, w: number) => {
    const d = Math.floor(v);
    return `${String(d).padStart(w, "0")}${((v - d) * 60).toFixed(2).padStart(5, "0")}`;
  };
  return {
    src,
    dst: "APRS",
    path: [],
    payload: `!${dm(lat, 2)}N/${dm(lon, 3)}E>`,
    kind: "position",
    heardVia: "rf",
    port: "meshcom",
    ts: now(),
    parsed: { meshcom: { srcType: "lora", receiver: RX, ...meta } },
  };
};

async function seed(e: Env) {
  const r = await call(
    e,
    "POST",
    "/ingest",
    {
      packets: [
        // the receiving node's own position, so its links have both ends
        { ...pkt(RX, 47.07, 15.44, { srcType: "node", path: [RX] }), heardVia: "aprs_is" },
        pkt("OE8XYZ-1", 47.1, 15.5, {
          direct: true,
          path: ["OE8XYZ-1"],
          rssi: -95,
          snr: 7,
          batt: 91,
          hwId: 8,
          firmware: "4.35t",
        }),
        pkt("OE8RLY-2", 47.3, 15.9, { direct: true, path: ["OE8RLY-2"], rssi: -118, snr: -12 }),
        pkt("DL1AAA-1", 48.2, 16.4, { direct: false, path: ["DL1AAA-1", "OE8RLY-2"], rssi: -118, snr: -12, batt: 20 }),
      ],
    },
    SECRET,
  );
  expect(r.status).toBe(200);
}

describe("GET /api/meshcom/nodes", () => {
  it("shows nodes with plain-language signal and battery to a visitor, and no exact figures", async () => {
    const e = env();
    await seed(e);
    const r = await call(e, "GET", "/api/meshcom/nodes");
    expect(r.status).toBe(200);
    expect(r.data.exact).toBe(false);
    const xyz = r.data.nodes.find((n: { callsign: string }) => n.callsign === "OE8XYZ-1");
    expect(xyz).toEqual({
      callsign: "OE8XYZ-1",
      lat: expect.closeTo(47.1, 3),
      lon: expect.closeTo(15.5, 3),
      symbol: expect.any(String),
      lastHeard: expect.any(Number),
      via: "direct",
      receiver: RX,
      hwId: 8,
      firmware: "4.35t",
      quality: "strong",
      battLevel: "high",
    });
    const relayed = r.data.nodes.find((n: { callsign: string }) => n.callsign === "DL1AAA-1");
    expect(relayed).toMatchObject({ via: "relayed", battLevel: "low" });
  });

  it("adds the exact battery and signal for a signed-in member", async () => {
    const e = env();
    await seed(e);
    const s = await emailSignup(e, "a@example.test", "DL1MEM");
    const r = await call(e, "GET", "/api/meshcom/nodes", undefined, { cookie: s.cookie });
    expect(r.data.exact).toBe(true);
    const xyz = r.data.nodes.find((n: { callsign: string }) => n.callsign === "OE8XYZ-1");
    expect(xyz).toMatchObject({ batt: 91, rssi: -95, snr: 7, quality: "strong", battLevel: "high" });
  });

  it("filters by the map's box and caps the result", async () => {
    const e = env();
    await seed(e);
    const box = await call(e, "GET", "/api/meshcom/nodes?bbox=15.0,46.9,15.6,47.2");
    expect(box.data.nodes.map((n: { callsign: string }) => n.callsign).sort()).toEqual([RX, "OE8XYZ-1"].sort());
    const one = await call(e, "GET", "/api/meshcom/nodes?limit=1");
    expect(one.data.nodes).toHaveLength(1);
    const bad = await call(e, "GET", "/api/meshcom/nodes?bbox=nope&limit=99999");
    expect(bad.data.nodes).toHaveLength(4);
  });
});

describe("GET /api/meshcom/links", () => {
  it("returns links with both ends placed, the kind and a quality bucket", async () => {
    const e = env();
    await seed(e);
    const r = await call(e, "GET", "/api/meshcom/links");
    const byPair = Object.fromEntries(r.data.links.map((l: { from: string; to: string }) => [`${l.from}>${l.to}`, l]));
    expect(Object.keys(byPair).sort()).toEqual(["OE8XYZ-1>" + RX, "OE8RLY-2>" + RX, "DL1AAA-1>OE8RLY-2"].sort());
    expect(byPair[`OE8XYZ-1>${RX}`]).toEqual({
      from: "OE8XYZ-1",
      to: RX,
      kind: "direct",
      lastSeen: expect.any(Number),
      samples: 1,
      receiver: RX,
      fromLat: expect.any(Number),
      fromLon: expect.any(Number),
      toLat: expect.any(Number),
      toLon: expect.any(Number),
      quality: "strong",
    });
    // the relay leg into the receiver carries the signal; the leg before it has none
    expect(byPair[`OE8RLY-2>${RX}`]).toMatchObject({ quality: "weak" });
    expect(byPair["DL1AAA-1>OE8RLY-2"]).toMatchObject({ kind: "relay", quality: null });
  });

  it("gives exact averages only to a signed-in member", async () => {
    const e = env();
    await seed(e);
    const anon = await call(e, "GET", "/api/meshcom/links");
    expect(anon.data.links.every((l: object) => !("snr" in l) && !("rssi" in l))).toBe(true);
    const s = await emailSignup(e, "a@example.test", "DL1MEM");
    const mem = await call(e, "GET", "/api/meshcom/links", undefined, { cookie: s.cookie });
    const direct = mem.data.links.find((l: { kind: string; from: string }) => l.from === "OE8XYZ-1");
    expect(direct).toMatchObject({ rssi: -95, snr: 7 });
  });

  it("leaves out a link whose end has no known position, and filters by the box", async () => {
    const e = env();
    await seed(e);
    await call(
      e,
      "POST",
      "/ingest",
      {
        packets: [
          {
            ...pkt("OE8NOP-1", 47, 15, { direct: true, path: ["OE8NOP-1"], snr: 1 }),
            payload: ":OE8ABC   :hi",
            kind: "message",
          },
        ],
      },
      SECRET,
    );
    const all = await call(e, "GET", "/api/meshcom/links");
    expect(all.data.links.some((l: { from: string }) => l.from === "OE8NOP-1")).toBe(false);
    const box = await call(e, "GET", "/api/meshcom/links?bbox=16.0,48.0,16.8,48.4");
    expect(box.data.links.map((l: { from: string }) => l.from)).toEqual(["DL1AAA-1"]);
  });
});
