// SPDX-License-Identifier: AGPL-3.0-or-later
// MeshCom node state and links for the map: stored from the operator's own ingest only, rewritten only
// when a shown value changes or the interval passes, pruned nightly, and never a trust input.
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { makeD1 } from "../src/d1.js";
import { migrate } from "../src/migrate.js";
import { handleIngest } from "@aprscaching/gateway/ingest";
import { pruneMeshcom } from "@aprscaching/gateway/meshcom";
import type { Env } from "@aprscaching/gateway/env";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");
const RX = "OE8APR-12";

function setup(extra: Record<string, unknown> = {}) {
  const sqlite = new Database(":memory:");
  migrate(sqlite, MIGRATIONS);
  const room = { fetch: async () => new Response(null, { status: 204 }) };
  const ROOMS = { idFromName: (n: string) => n, get: () => room };
  const env = { DB: makeD1(sqlite), INGEST_SECRET: "s", ROOMS, ...extra } as unknown as Env;
  const changes = () => (sqlite.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
  return { sqlite, env, changes };
}

type Meta = Record<string, unknown>;
const pkt = (src: string, ts: number, meta: Meta | null, over: Record<string, unknown> = {}) => ({
  src,
  dst: "APRS",
  path: [],
  payload: "!4704.41N/01526.27E>",
  kind: "position",
  heardVia: "rf",
  port: "meshcom",
  rxCall: RX,
  ts,
  ...(meta ? { parsed: { lat: 47.0735, lon: 15.4378, meshcom: meta } } : {}),
  ...over,
});
const direct = (over: Meta = {}): Meta => ({
  srcType: "lora",
  direct: true,
  path: ["OE8XYZ-1"],
  receiver: RX,
  rssi: -100,
  snr: 6,
  hwId: 8,
  firmware: "4.35t",
  batt: 87,
  ...over,
});

async function ingest(env: Env, packets: unknown[], headers: Record<string, string> = { "x-ingest-secret": "s" }) {
  const res = await handleIngest(
    new Request("http://gw/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ packets }),
    }),
    env,
    { waitUntil: () => {} } as never,
  );
  expect(res.status).toBe(200);
}
const node = (sqlite: Database.Database, call: string) =>
  sqlite.prepare("SELECT * FROM meshcom_nodes WHERE callsign = ?").get(call) as Record<string, unknown> | undefined;
const links = (sqlite: Database.Database) =>
  sqlite
    .prepare(
      "SELECT from_call, to_call, kind, samples, rssi_avg, snr_avg FROM meshcom_links ORDER BY from_call, to_call",
    )
    .all();
// the ingest clamps a timestamp to at most a minute ahead, so the tests run in the recent past
const now = () => Math.floor(Date.now() / 1000) - 2000;

describe("MeshCom node state", () => {
  it("stores a node's device, battery, how it was heard and the signal", async () => {
    const { sqlite, env } = setup();
    await ingest(env, [pkt("OE8XYZ-1", now(), direct())]);
    expect(node(sqlite, "OE8XYZ-1")).toMatchObject({
      hw_id: 8,
      firmware: "4.35t",
      batt: 87,
      last_via: "direct",
      last_rssi: -100,
      last_snr: 6,
      quality: "strong",
      receiver: RX,
    });
  });

  it("writes nothing for a packet that changes nothing shown, within the interval", async () => {
    const { sqlite, env } = setup();
    const t = now();
    await ingest(env, [pkt("OE8XYZ-1", t, direct())]);
    const rowBefore = node(sqlite, "OE8XYZ-1");
    const linksBefore = sqlite.prepare("SELECT * FROM meshcom_links").all();
    // a slightly different signal in the same quality bucket, a battery in the same 10 % step
    await ingest(env, [pkt("OE8XYZ-1", t + 30, direct({ rssi: -101, snr: 5.5, batt: 85 }))]);
    expect(node(sqlite, "OE8XYZ-1")).toEqual(rowBefore);
    expect(sqlite.prepare("SELECT * FROM meshcom_links").all()).toEqual(linksBefore);
  });

  it("writes once a shown value changes, or the interval passes", async () => {
    const { sqlite, env } = setup();
    const t = now();
    await ingest(env, [pkt("OE8XYZ-1", t, direct())]);
    await ingest(env, [pkt("OE8XYZ-1", t + 30, direct({ batt: 40 }))]);
    expect(node(sqlite, "OE8XYZ-1")?.batt).toBe(40);
    await ingest(env, [pkt("OE8XYZ-1", t + 60, direct({ snr: -12 }))]);
    expect(node(sqlite, "OE8XYZ-1")?.quality).toBe("weak");
    await ingest(env, [pkt("OE8XYZ-1", t + 90, direct({ srcType: "udp", direct: false }))]);
    expect(node(sqlite, "OE8XYZ-1")).toMatchObject({ last_via: "server", quality: "weak", last_snr: -12 });
    await ingest(env, [pkt("OE8XYZ-1", t + 90 + 300, direct({ srcType: "udp", direct: false }))]);
    expect(node(sqlite, "OE8XYZ-1")?.last_heard).toBe(t + 390);
  });

  it("keeps the interval an operator sets", async () => {
    const { sqlite, env } = setup({ MESHCOM_META_MIN_S: "30" });
    const t = now();
    await ingest(env, [pkt("OE8XYZ-1", t, direct())]);
    await ingest(env, [pkt("OE8XYZ-1", t + 31, direct())]);
    expect(node(sqlite, "OE8XYZ-1")?.last_heard).toBe(t + 31);
  });

  it("takes MeshCom metadata only from the operator's own ingest, and only on the MeshCom port", async () => {
    const { sqlite, env } = setup();
    await ingest(env, [pkt("OE8XYZ-1", now(), direct(), { port: "aprs-is" })]);
    expect(node(sqlite, "OE8XYZ-1")).toBeUndefined();
    const signed = setup();
    const res = await handleIngest(
      new Request("http://gw/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packets: [pkt("OE8XYZ-1", now(), direct())] }),
      }),
      signed.env,
      { waitUntil: () => {} } as never,
    );
    expect(res.status).toBe(401); // no secret, no valid signature: nothing stored at all
    expect(node(signed.sqlite, "OE8XYZ-1")).toBeUndefined();
  });

  it("drops invalid metadata instead of storing it", async () => {
    const { sqlite, env } = setup();
    await ingest(env, [pkt("OE8XYZ-1", now(), direct({ batt: 400, hwId: "T-Deck", firmware: "<script>" }))]);
    expect(node(sqlite, "OE8XYZ-1")).toMatchObject({ batt: null, hw_id: null, firmware: null, last_via: "direct" });
  });
});

describe("MeshCom links", () => {
  it("a direct hearing is one link into the receiver, with its signal", async () => {
    const { sqlite, env } = setup();
    await ingest(env, [pkt("OE8XYZ-1", now(), direct())]);
    expect(links(sqlite)).toEqual([
      { from_call: "OE8XYZ-1", to_call: RX, kind: "direct", samples: 1, rssi_avg: -100, snr_avg: 6 },
    ]);
  });

  it("a relayed frame gives each leg, with the signal only on the leg into the receiver", async () => {
    const { sqlite, env } = setup();
    await ingest(env, [pkt("DL1AAA-1", now(), direct({ direct: false, path: ["DL1AAA-1", "OE8XYZ-1", "OE8RLY-2"] }))]);
    expect(links(sqlite)).toEqual([
      { from_call: "DL1AAA-1", to_call: "OE8XYZ-1", kind: "relay", samples: 1, rssi_avg: null, snr_avg: null },
      { from_call: "OE8RLY-2", to_call: RX, kind: "relay", samples: 1, rssi_avg: -100, snr_avg: 6 },
      { from_call: "OE8XYZ-1", to_call: "OE8RLY-2", kind: "relay", samples: 1, rssi_avg: null, snr_avg: null },
    ]);
  });

  it("a frame the MeshCom server relayed, or the node's own, adds no link", async () => {
    const { sqlite, env } = setup();
    await ingest(env, [
      pkt("OE8XYZ-1", now(), direct({ srcType: "udp", direct: false })),
      pkt(RX, now(), { srcType: "node", path: [RX], receiver: RX }),
    ]);
    expect(links(sqlite)).toEqual([]);
    expect(node(sqlite, RX)?.last_via).toBe("node");
  });

  it("averages a link's signal over its recent samples, one sample per interval", async () => {
    const { sqlite, env } = setup({ MESHCOM_META_MIN_S: "10" });
    const t = now();
    await ingest(env, [pkt("OE8XYZ-1", t, direct({ snr: 8 }))]);
    await ingest(env, [pkt("OE8XYZ-1", t + 5, direct({ snr: -20 }))]); // within the interval: not a sample
    await ingest(env, [pkt("OE8XYZ-1", t + 10, direct({ snr: 0 }))]);
    const l = links(sqlite)[0] as { samples: number; snr_avg: number };
    expect(l.samples).toBe(2);
    expect(l.snr_avg).toBe(4);
  });
});

describe("pruning and trust", () => {
  it("drops nodes and links not heard within their windows", async () => {
    const { sqlite, env } = setup();
    const t = now();
    await ingest(env, [pkt("OE8XYZ-1", t, direct())]);
    await pruneMeshcom(env, t + 47 * 3600);
    expect(links(sqlite)).toHaveLength(1);
    await pruneMeshcom(env, t + 49 * 3600);
    expect(links(sqlite)).toHaveLength(0);
    expect(node(sqlite, "OE8XYZ-1")).toBeDefined();
    await pruneMeshcom(env, t + 8 * 86400);
    expect(node(sqlite, "OE8XYZ-1")).toBeUndefined();
  });

  it("stores the same position, station and provenance with or without metadata", async () => {
    const t = now();
    const rows = async (meta: Meta | null) => {
      const { sqlite, env } = setup();
      await ingest(env, [pkt("OE8XYZ-1", t, meta, { igateCall: RX })]);
      return {
        positions: sqlite
          .prepare("SELECT callsign, ts, lat, lon, heard_via, igate_call, path, source, transport FROM positions")
          .all(),
        stations: sqlite.prepare("SELECT callsign, lat, lon, source_call FROM stations").all(),
      };
    };
    expect(await rows(direct())).toEqual(await rows(null));
  });
});
