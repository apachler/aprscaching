// SPDX-License-Identifier: MIT
// INP3 wire codec + routing table: RIF encode/decode with options, L3RTT probe framing, RTT
// smoothing, and the best-tt table with triggered updates, horizon, and withdrawal.
import { describe, it, expect } from "vitest";
import { parseAddr, addrStr } from "@aprscaching/ax25";
import {
  encodeRif,
  decodeRif,
  encodeL3rttFrame,
  decodeL3rttFrame,
  smoothRtt,
  ttFromRtt,
  INP_RIF,
  INP_TT_WITHDRAW,
  type Rip,
} from "../src/inp3.js";
import { Inp3Table } from "../src/inp3-table.js";

const rip = (dest: string, hops: number, tt: number, alias?: string): Rip => ({
  dest: parseAddr(dest),
  hops,
  tt,
  alias,
});

describe("INP3 RIF codec", () => {
  it("round-trips a RIF with alias and IP options", () => {
    const rips: Rip[] = [
      { ...rip("OE8XBM-7", 2, 45, "GRAZ") },
      { dest: parseAddr("DB0XYZ-7"), hops: 4, tt: 120, alias: "MUC", ip: { addr: [44, 128, 1, 2], bits: 24 } },
    ];
    const info = encodeRif(rips);
    expect(info[0]).toBe(INP_RIF);
    const back = decodeRif(info)!;
    expect(back).toHaveLength(2);
    expect(back[0]).toMatchObject({ hops: 2, tt: 45, alias: "GRAZ" });
    expect(back[0]!.dest.call).toBe("OE8XBM");
    expect(back[0]!.dest.ssid).toBe(7);
    expect(back[1]).toMatchObject({ hops: 4, tt: 120, alias: "MUC" });
    expect(back[1]!.ip).toEqual({ addr: [44, 128, 1, 2], bits: 24 });
  });

  it("encodes tt big-endian and rejects a non-RIF buffer", () => {
    const info = encodeRif([rip("OE1ABC", 1, 0x0102)]);
    // RIF(1) + dest(7) then hops at [8], tt hi/lo at [9]/[10]
    expect(info[8]).toBe(0x01); // hops
    expect(info[9]).toBe(0x01); // tt high byte
    expect(info[10]).toBe(0x02); // tt low byte
    expect(decodeRif(new Uint8Array([0x00, 1, 2, 3]))).toBeNull();
  });
});

describe("INP3 L3RTT probe", () => {
  it("round-trips through the NET/ROM L4 frame (dest L3RTT, ttl 2, opcode 0x05)", () => {
    const bytes = encodeL3rttFrame(parseAddr("OE1ACS-7"), { origin: "OE1ACS-7", seq: 12345, alias: "ACS" });
    const back = decodeL3rttFrame(bytes)!;
    expect(back).not.toBeNull();
    expect(back.origin.call).toBe("OE1ACS");
    expect(back.rtt).toMatchObject({ origin: "OE1ACS-7", seq: 12345, alias: "ACS" });
    // a plain NET/ROM frame to another dest is not an L3RTT probe
    expect(decodeL3rttFrame(new Uint8Array(20))).toBeNull();
  });

  it("smooths RTT (7:1 exponential) and derives tt as half the round trip", () => {
    expect(smoothRtt(null, 80)).toBe(80); // first sample seeds
    expect(smoothRtt(80, 160)).toBe(90); // (7*80 + 160)/8 = 90
    expect(ttFromRtt(90)).toBe(45); // tt = rtt/2
    expect(ttFromRtt(1)).toBe(1); // never below the direct-neighbour floor
  });
});

describe("INP3 routing table", () => {
  it("adds a route with tt = neighbour tt + link tt, ranks by lowest tt", () => {
    const t = new Inp3Table();
    expect(t.applyRip(rip("OE8XBM-7", 2, 40, "GRAZ"), "OE1NB1", 10)).toBe("added");
    const r = t.best("OE8XBM-7")!;
    expect(r.tt).toBe(50); // 40 + 10
    expect(r.neighbor).toBe("OE1NB1");
    expect(r.hops).toBe(3); // rip hops + 1
  });

  it("prefers a lower-tt neighbour and marks the change dirty for triggered update", () => {
    const t = new Inp3Table();
    t.applyRip(rip("OE8XBM-7", 2, 100), "SLOW", 10); // tt 110
    t.drainDirty(); // clear the initial add
    expect(t.applyRip(rip("OE8XBM-7", 2, 40), "FAST", 10)).toBe("updated"); // tt 50 < 110
    expect(t.best("OE8XBM-7")!.neighbor).toBe("FAST");
    const dirty = t.drainDirty();
    expect(dirty.map((d) => d.dest.call)).toContain("OE8XBM");
    // a worse neighbour is ignored and does not dirty
    expect(t.applyRip(rip("OE8XBM-7", 2, 200), "SLOW", 10)).toBe("ignored");
    expect(t.drainDirty()).toHaveLength(0);
  });

  it("enforces the hop horizon and honours a withdrawal from the active neighbour", () => {
    const t = new Inp3Table();
    expect(t.applyRip(rip("FAR-7", 40, 10), "NB", 1)).toBe("ignored"); // 41 hops > 30 horizon
    t.applyRip(rip("OE8XBM-7", 2, 40), "NB", 10);
    expect(t.applyRip(rip("OE8XBM-7", 2, INP_TT_WITHDRAW), "OTHER", 10)).toBe("ignored"); // not our neighbour
    expect(t.applyRip(rip("OE8XBM-7", 2, INP_TT_WITHDRAW), "NB", 10)).toBe("withdrawn");
    expect(t.best("OE8XBM-7")).toBeNull();
  });

  it("two nodes converge by exchanging self-RIPs over the wire codec", () => {
    // A advertises itself to B; B advertises itself to A — each learns the other, ranked by link tt.
    const a = new Inp3Table();
    const b = new Inp3Table();
    const selfA: Rip = { dest: parseAddr("OE1AAA-7"), hops: 0, tt: 0, alias: "ACSA" };
    const selfB: Rip = { dest: parseAddr("OE1BBB-7"), hops: 0, tt: 0, alias: "ACSB" };
    // the frames actually cross the RIF encoder/decoder, as they would on the air
    for (const r of decodeRif(encodeRif([selfA]))!) b.applyRip(r, "OE1AAA-7", 1);
    for (const r of decodeRif(encodeRif([selfB]))!) a.applyRip(r, "OE1BBB-7", 1);
    expect(a.best("ACSB")?.dest).toBe("OE1BBB-7");
    expect(a.best("ACSB")?.neighbor).toBe("OE1BBB-7");
    expect(b.best("ACSA")?.neighbor).toBe("OE1AAA-7");
    // snapshot advertises every route; split horizon (done by the node) would drop a route back to its
    // own next hop — here A's only route is via OE1BBB-7, so it must not be re-advertised to OE1BBB-7.
    const snap = a.snapshot();
    expect(snap).toHaveLength(1);
    const splitHorizon = snap.filter((r) => a.best(addrStr(r.dest))?.neighbor !== "OE1BBB-7");
    expect(splitHorizon).toHaveLength(0);
  });

  it("expires stale routes and reports the withdrawn destinations", () => {
    const t = new Inp3Table();
    t.applyRip(rip("A-7", 1, 10), "NB", 1);
    t.applyRip(rip("B-7", 1, 10), "NB", 1);
    const gone = t.expire((r) => r.dest === "A-7");
    expect(gone).toEqual(["A-7"]);
    expect(t.best("A-7")).toBeNull();
    expect(t.best("B-7")).not.toBeNull();
  });
});
