// SPDX-License-Identifier: AGPL-3.0-or-later
// Receive-side peer enforcement for the tunnelled AX.25 ports: with peers configured, frames from any
// other host never reach the node, the BBS or the ingest.
import { describe, it, expect, vi } from "vitest";
import dgram from "node:dgram";
import { encodeFrame, parseAddr, type Ax25Frame } from "@aprscaching/ax25";
import { PeerAllowlist, normalizeAddress } from "../src/peerfilter.js";
import { AxudpPort, AxudpListener } from "../src/axudp.js";
import { AxipPort, ipv4Source } from "../src/axip.js";

const quiet = () => {};

describe("PeerAllowlist", () => {
  it("accepts literal peer addresses and IPv4-mapped forms of them", async () => {
    const a = new PeerAllowlist({ name: "t", hosts: ["192.0.2.7"], log: quiet });
    await a.refresh();
    expect(a.allows("192.0.2.7")).toBe(true);
    expect(a.allows("::ffff:192.0.2.7")).toBe(true);
    expect(normalizeAddress("::FFFF:10.0.0.1")).toBe("10.0.0.1");
  });

  it("drops and counts anything else, logging each source at most once a minute", async () => {
    const log = vi.fn();
    const a = new PeerAllowlist({ name: "axudp", hosts: ["192.0.2.7"], log });
    await a.refresh();
    expect(a.allows("198.51.100.1")).toBe(false);
    expect(a.allows("198.51.100.1")).toBe(false);
    expect(a.allows(undefined)).toBe(false);
    expect(a.dropped).toBe(3);
    expect(log).toHaveBeenCalledTimes(2); // one per distinct source
    expect(log.mock.calls[0]![0]).toMatch(/dropped a frame from 198\.51\.100\.1 — not a configured peer/);
  });

  it("resolves host names and picks up a changed address on the next refresh", async () => {
    let addr = "203.0.113.5";
    const a = new PeerAllowlist({ name: "t", hosts: ["bpq.example.net"], resolve: async () => [addr], log: quiet });
    await a.refresh();
    expect(a.allows("203.0.113.5")).toBe(true);
    addr = "203.0.113.9"; // dynamic DNS moved the peer
    await a.refresh();
    expect(a.allows("203.0.113.9")).toBe(true);
    expect(a.allows("203.0.113.5")).toBe(false);
  });

  it("keeps the last good addresses when a lookup fails", async () => {
    let fail = false;
    const a = new PeerAllowlist({
      name: "t",
      hosts: ["bpq.example.net"],
      resolve: async () => {
        if (fail) throw new Error("SERVFAIL");
        return ["203.0.113.5"];
      },
      log: quiet,
    });
    await a.refresh();
    fail = true;
    await a.refresh();
    expect(a.allows("203.0.113.5")).toBe(true);
  });
});

describe("AxudpPort enforces its peers on receive", () => {
  const frame = (info: string): Ax25Frame => ({
    dst: parseAddr("NODES"),
    src: parseAddr("GB7BPQ-7"),
    command: true,
    type: "UI",
    pf: false,
    pid: 0xf0,
    info: new TextEncoder().encode(info),
  });
  const sender = (address: string): Promise<dgram.Socket> =>
    new Promise((resolve) => {
      const s = dgram.createSocket("udp4");
      s.bind(0, address, () => resolve(s));
    });
  const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

  it("passes a peer's frames and drops a stranger's, counting the drop", async () => {
    const packets: string[] = [];
    const raw: number[] = [];
    const port = new AxudpPort(
      { port: 0, bind: "127.0.0.1", peers: [{ host: "127.0.0.1", port: 10093 }], refreshMs: 60_000 },
      (p) => packets.push(p.src),
    );
    port.onRaw((b) => raw.push(b.length));
    port.start();
    await settle(50);
    const bound = (port as unknown as { sock: dgram.Socket }).sock.address().port;
    const peer = await sender("127.0.0.1");
    const stranger = await sender("127.0.0.2");
    stranger.send(encodeFrame(frame(">from a stranger")), bound, "127.0.0.1");
    peer.send(encodeFrame(frame(">from the peer")), bound, "127.0.0.1");
    await settle();
    port.stop();
    peer.close();
    stranger.close();
    expect(packets).toEqual(["GB7BPQ-7"]);
    expect(raw).toHaveLength(1);
    expect(port.dropped).toBe(1);
  });

  it("a receive-only listener warns once that it accepts from any host", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const l = new AxudpListener({ port: 0, bind: "127.0.0.1" }, () => {});
    l.start();
    l.stop();
    const hits = warn.mock.calls.filter((c) =>
      /no AXUDP_PEERS configured — accepting tunnelled frames from any host/.test(String(c[0])),
    );
    warn.mockRestore();
    expect(hits).toHaveLength(1);
  });
});

describe("AxipPort enforces its peers on receive", () => {
  const ipv4From = (src: number[], payload: Uint8Array): Uint8Array => {
    const out = new Uint8Array(20 + payload.length);
    out[0] = 0x45;
    out[9] = 93;
    out.set(src, 12);
    out.set(payload, 20);
    return out;
  };
  const ax = encodeFrame({
    dst: parseAddr("APRS"),
    src: parseAddr("DB0ABC"),
    command: true,
    type: "UI",
    pf: false,
    pid: 0xf0,
    info: new TextEncoder().encode(">hi"),
  });

  it("reads the sender from the IPv4 header", () => {
    expect(ipv4Source(ipv4From([192, 0, 2, 7], ax))).toBe("192.0.2.7");
    expect(ipv4Source(ax)).toBeNull();
  });

  it("passes a peer's datagram and drops a stranger's", async () => {
    const packets: string[] = [];
    const port = new AxipPort({ peers: [{ host: "192.0.2.7" }] }, (p) => packets.push(p.src));
    await port.allowlist.refresh();
    port.receive(ipv4From([198, 51, 100, 1], ax));
    port.receive(ipv4From([192, 0, 2, 7], ax));
    expect(packets).toEqual(["DB0ABC"]);
    expect(port.dropped).toBe(1);
  });

  it("falls back to the socket-reported source without an IP header", async () => {
    const packets: string[] = [];
    const port = new AxipPort({ peers: [{ host: "192.0.2.7" }] }, (p) => packets.push(p.src));
    await port.allowlist.refresh();
    port.receive(ax, "192.0.2.7");
    port.receive(ax, "198.51.100.1");
    expect(packets).toEqual(["DB0ABC"]);
  });
});
