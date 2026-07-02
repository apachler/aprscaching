// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { routeNetrom } from "../src/netrom-switch.js";
import { NetromNode } from "../src/netrom-node.js";
import { encodeNodesBroadcast, type NrPacket } from "../src/netrom-wire.js";
import { addrStr, type Ax25Address } from "@aprsweb/ax25";

const A = (call: string, ssid = 0): Ax25Address => ({ call, ssid });
const ME = A("OE8NOD", 1);

const pkt = (dest: Ax25Address, ttl: number, origin = A("OE1SRC")): NrPacket => ({
  net: { origin, dest, ttl },
  tp: { opcode: 5, flags: 0, circuitIndex: 1, circuitId: 2, txSeq: 0, rxSeq: 0 },
  info: new Uint8Array([1, 2, 3]),
});

function nodeWithRoute(dest: Ax25Address, neighbor: Ax25Address): NetromNode {
  const n = new NetromNode({ call: ME, alias: "OENODE" }, { pathQuality: 200 });
  n.consume(encodeNodesBroadcast("N", [{ dest, alias: "FAR", neighbor, quality: 180 }])[0]!, neighbor);
  return n;
}

describe("NET/ROM L3 switch (docs/design/29 F2 — transit routing)", () => {
  it("delivers a packet addressed to us locally", () => {
    const d = routeNetrom(pkt(ME, 20), new NetromNode({ call: ME, alias: "X" }), ME);
    expect(d).toEqual({ action: "local" });
  });

  it("forwards a transit packet toward its destination with TTL-1", () => {
    const node = nodeWithRoute(A("OE3FAR"), A("OE2NBR"));
    const d = routeNetrom(pkt(A("OE3FAR"), 20), node, ME);
    expect(d.action).toBe("forward");
    if (d.action === "forward") {
      expect(addrStr(d.neighbor)).toBe("OE2NBR");
      expect(d.packet.net.ttl).toBe(19);                 // decremented
      expect(d.packet.info).toEqual(new Uint8Array([1, 2, 3])); // payload preserved
    }
  });

  it("drops on TTL expiry", () => {
    const node = nodeWithRoute(A("OE3FAR"), A("OE2NBR"));
    expect(routeNetrom(pkt(A("OE3FAR"), 1), node, ME)).toEqual({ action: "drop", reason: "ttl" });
  });

  it("drops when there is no route to the destination", () => {
    const node = new NetromNode({ call: ME, alias: "X" });
    expect(routeNetrom(pkt(A("OE9NONE"), 20), node, ME)).toEqual({ action: "drop", reason: "no-route" });
  });

  it("drops a self-loop (route points back at us or the origin)", () => {
    const backToOrigin = nodeWithRoute(A("OE3FAR"), A("OE1SRC")); // neighbour == the packet's origin
    expect(routeNetrom(pkt(A("OE3FAR"), 20, A("OE1SRC")), backToOrigin, ME)).toEqual({ action: "drop", reason: "loop" });
  });
});
