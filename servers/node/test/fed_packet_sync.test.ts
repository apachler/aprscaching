// SPDX-License-Identifier: AGPL-3.0-or-later
// Federation pull over packet circuits, the gateway's side: the ingest box reads which peers publish an ax25 or
// netrom endpoint, and reports each session; the report moves the packet path's own cursors and shows in the
// peer list Instance admin reads.
import { describe, it, expect } from "vitest";
import { authEnv, call } from "./helpers/authflow.js";

const INGEST = { "x-ingest-secret": "test-ingest-secret" };
const OPERATOR = { "x-operator-secret": "test-operator-secret" };

async function withPeers() {
  const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR" });
  const add = (url: string, instance: string, endpoints: unknown, trust = "trusted", enabled = 1) =>
    env.DB.prepare("INSERT INTO fed_peers (url, instance, endpoints, trust, enabled) VALUES (?, ?, ?, ?, ?)")
      .bind(url, instance, JSON.stringify(endpoints), trust, enabled)
      .run();
  await add("https://radio.example", "oe.radio", [
    { transport: "https", address: "https://radio.example", priority: 10 },
    { transport: "netrom", address: "ACSB", priority: 40 },
    { transport: "ax25", address: "OE1BBB-9", priority: 30 },
  ]);
  await add("https://web.example", "oe.web", [{ transport: "https", address: "https://web.example", priority: 10 }]);
  await add(
    "https://blocked.example",
    "oe.blocked",
    [{ transport: "ax25", address: "OE9XXX-9", priority: 10 }],
    "blocked",
  );
  await add("https://off.example", "oe.off", [{ transport: "ax25", address: "OE9OFF-9", priority: 10 }], "unvetted", 0);
  return env;
}

describe("packet peers and session reports", () => {
  it("lists only enabled, unblocked peers with a packet endpoint, in priority order", async () => {
    const env = await withPeers();
    const r = await call(env, "GET", "/federation/packet/peers", undefined, INGEST);
    expect(r.status).toBe(200);
    expect(r.data.total).toBe(1);
    expect(r.data.never).toBe(1);
    expect(r.data.peers[0].instance).toBe("oe.radio");
    expect(r.data.peers[0].endpoints).toEqual([
      { transport: "ax25", address: "OE1BBB-9" },
      { transport: "netrom", address: "ACSB" },
    ]);
    expect(r.data.peers[0].cursors).toEqual({});
  });

  it("takes the ingest credential, never an anonymous caller", async () => {
    const env = await withPeers();
    expect([401, 403]).toContain((await call(env, "GET", "/federation/packet/peers")).status);
    expect((await call(env, "GET", "/federation/packet/peers", undefined, { "x-ingest-secret": "wrong" })).status).toBe(
      401,
    );
    const body = { instance: "oe.radio", transport: "ax25", address: "OE1BBB-9", ok: true };
    expect([401, 403]).toContain((await call(env, "POST", "/federation/packet/status", body)).status);
  });

  it("a report moves the cursors and the status the peer list shows", async () => {
    const env = await withPeers();
    const ok = await call(
      env,
      "POST",
      "/federation/packet/status",
      {
        instance: "oe.radio",
        transport: "ax25",
        address: "OE1BBB-9",
        ok: true,
        pages: 3,
        frames: 40,
        applied: 38,
        complete: false,
        cursors: { cache: { since: 1700000000, sinceId: 12 }, find: { since: 5 }, bogus: { since: 1 } },
      },
      INGEST,
    );
    expect(ok.status).toBe(200);
    let peers = await call(env, "GET", "/federation/packet/peers", undefined, INGEST);
    expect(peers.data.peers[0].cursors).toEqual({ cache: { since: 1700000000, sinceId: 12 }, find: { since: 5 } });
    expect(peers.data.peers[0].lastOk).toBeGreaterThan(0);

    // a failed session keeps the last success and the cursors it did not move
    await call(
      env,
      "POST",
      "/federation/packet/status",
      { instance: "oe.radio", transport: "ax25", address: "OE1BBB-9", ok: false, error: "connect timed out" },
      INGEST,
    );
    peers = await call(env, "GET", "/federation/packet/peers", undefined, INGEST);
    expect(peers.data.failing).toBe(1);
    expect(peers.data.peers[0].cursors.cache).toEqual({ since: 1700000000, sinceId: 12 });

    const list = await call(env, "GET", "/federation/peers", undefined, OPERATOR);
    const radio = (list.data.peers as { instance: string; packet: Record<string, unknown>; health: string }[]).find(
      (p) => p.instance === "oe.radio",
    );
    expect(radio?.packet).toMatchObject({ transport: "ax25", address: "OE1BBB-9", lastError: "connect timed out" });
    expect(radio?.packet.lastOk).toBeGreaterThan(0);
    expect(radio?.health).toBe("error"); // never pulled over http: health follows the packet session
  });

  it("refuses a report about an instance that is not a peer, or is blocked", async () => {
    const env = await withPeers();
    const body = (instance: string) => ({ instance, transport: "ax25", address: "OE9XXX-9", ok: true });
    expect((await call(env, "POST", "/federation/packet/status", body("oe.nobody"), INGEST)).status).toBe(404);
    expect((await call(env, "POST", "/federation/packet/status", body("oe.blocked"), INGEST)).status).toBe(404);
    expect(
      (await call(env, "POST", "/federation/packet/status", { instance: "oe.radio", transport: "https" }, INGEST))
        .status,
    ).toBe(400);
  });
});
