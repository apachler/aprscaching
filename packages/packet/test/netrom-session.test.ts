import { describe, it, expect } from "vitest";
import { serveNetromApp } from "../src/netrom-session.js";
import { NetromCircuit, type NrTpPacket } from "../src/netrom-circuit.js";
import { NodeSession, type NodeStore } from "../src/netrom.js";
import { type Ax25Address } from "@aprsweb/ax25";

const A = (call: string, ssid = 0): Ax25Address => ({ call, ssid });
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const nodeStore: NodeStore = {
  nodes: () => [{ alias: "GRZ", call: "OE8NOD-2", quality: 200 }],
  routes: () => [], users: () => [{ call: "OE1USR" }], mheard: () => [], info: () => "APRScaching NET/ROM node",
};

describe("NET/ROM L4 inbound session server (docs/29 F2)", () => {
  it("accepts an inbound circuit and drives the node CLI over it", () => {
    // the far station's originating circuit; the near circuit is our accepting node session
    const q: Array<{ to: "near" | "far"; p: NrTpPacket }> = [];
    let rx = "";
    const far = new NetromCircuit(
      { send: (p) => q.push({ to: "near", p }), deliver: (b) => { rx += dec(b); }, state: () => {} },
      { index: 7, id: 70 }, { user: A("OE1USR"), node: A("OE8NOD", 1) },
    );
    const near = serveNetromApp({ index: 1, id: 10 }, new NodeSession("OE1USR", nodeStore, "OENODE", "OE8NOD-1"), {
      send: (p) => q.push({ to: "far", p }),
    });
    const pump = (g = 3000) => { while (q.length && g-- > 0) { const { to, p } = q.shift()!; (to === "near" ? near : far).onPacket(p.tp, p.info); } };

    far.connect(4); pump();                       // ConnReq → near accepts → greeting flows back
    expect(near.state).toBe("connected");
    expect(rx).toContain("NET/ROM node");         // the node greeting arrived over the circuit

    far.send(enc("N\r")); pump();                  // drive a command
    expect(rx).toContain("GRZ:OE8NOD-2");          // NODES list served over NET/ROM

    far.send(enc("B\r")); pump();                  // bye → disconnect
    expect(near.state).toBe("disconnected");
  });
});
