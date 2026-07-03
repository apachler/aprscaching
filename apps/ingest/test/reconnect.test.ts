// SPDX-License-Identifier: AGPL-3.0-or-later
// SR-ING-01: one transport failure must schedule exactly ONE reconnect. The old code retried on
// both `error` and `close` (a socket failure emits both), doubling the outstanding attempts each
// cycle — an exponential login storm against APRS-IS. Against a server that drops every
// connection, attempts must stay LINEAR in elapsed time.
import { describe, it, expect } from "vitest";
import net from "node:net";
import { AprsIs } from "../src/aprsis.js";
import { AprsUplink } from "../src/uplink.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A TCP server that accepts and immediately destroys every connection, counting attempts. */
function dropServer(): Promise<{ port: number; count: () => number; close: () => void }> {
  return new Promise((resolve) => {
    let n = 0;
    const srv = net.createServer((s) => { n++; s.destroy(); });
    srv.listen(0, "127.0.0.1", () => {
      resolve({ port: (srv.address() as net.AddressInfo).port, count: () => n, close: () => srv.close() });
    });
  });
}

describe("SR-ING-01 — reconnect is linear, never a storm", () => {
  it("AprsIs: ~1 attempt per retry interval against a dropping server", async () => {
    const srv = await dropServer();
    const is = new AprsIs({ host: "127.0.0.1", port: srv.port, callsign: "N0CALL", passcode: "-1", filter: "t/m", retryMs: 40 });
    is.on("down", () => {});
    is.start();
    await sleep(400);                       // ~10 retry cycles
    srv.close();
    // linear ⇒ ≈ 1 + 400/40 = 11 attempts; the double-retry bug gives 2^n ≫ 60 in the same window
    expect(srv.count()).toBeGreaterThanOrEqual(3);   // it IS retrying
    expect(srv.count()).toBeLessThanOrEqual(20);     // …but linearly
  });

  it("AprsUplink: same guarantee", async () => {
    const srv = await dropServer();
    const up = new AprsUplink({ host: "127.0.0.1", port: srv.port, serviceCall: "N0CALL", servicePass: "-1", retryMs: 40 });
    up.start();
    await sleep(400);
    srv.close();
    expect(srv.count()).toBeGreaterThanOrEqual(3);
    expect(srv.count()).toBeLessThanOrEqual(20);
  });
});
