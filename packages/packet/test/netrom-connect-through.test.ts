// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { SessionServer } from "../src/session-server.js";
import { NetromNode } from "../src/netrom-node.js";
import { nodeConnectThrough, parseConnectScript, ConnectSequencer, type CircuitDialer } from "../src/netrom-connect-through.js";
import { NodeSession, type NodeStore } from "../src/netrom.js";
import { NetromCircuit, type NrTpPacket } from "../src/netrom-circuit.js";
import { encodeNodesBroadcast } from "../src/netrom-wire.js";
import { ConnectedLink, type Ax25Address, type Ax25Frame } from "@aprsweb/ax25";

const A = (call: string, ssid = 0): Ax25Address => ({ call, ssid });
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const nodeStore: NodeStore = {
  nodes: () => [], routes: () => [], users: () => [], mheard: () => [], info: () => "node",
};

/** A CircuitDialer that bridges to a far NET/ROM circuit which echoes whatever it receives (a test peer). */
const echoDialer: CircuitDialer = (_route, hooks) => {
  const q: Array<{ to: "near" | "far"; p: NrTpPacket }> = [];
  const near = new NetromCircuit(
    { send: (p) => q.push({ to: "far", p }), deliver: (b) => hooks.onData(b), state: (s) => { if (s === "disconnected") hooks.onClose(); } },
    { index: 1, id: 10 }, { user: A("OE1USR"), node: A("OE8NOD", 1) },
  );
  const far = new NetromCircuit(
    { send: (p) => q.push({ to: "near", p }), deliver: (b) => far.send(b), state: () => {} },   // echo back
    { index: 2, id: 20 },
  );
  const pump = (g = 2000) => { while (q.length && g-- > 0) { const { to, p } = q.shift()!; (to === "near" ? near : far).onPacket(p.tp, p.info); } };
  near.connect(4); pump();
  return { send: (bytes) => { near.send(bytes); pump(); }, disconnect: () => { near.disconnect(); pump(); } };
};

describe("NET/ROM connect-through (docs/29 F2)", () => {
  function setup(dialer: CircuitDialer) {
    const node = new NetromNode({ call: A("OE8NOD", 1), alias: "OENODE" }, { pathQuality: 200 });
    node.consume(encodeNodesBroadcast("FAR", [{ dest: A("OE3FAR"), alias: "FAR", neighbor: A("OE2NBR"), quality: 180 }])[0]!, A("OE2NBR"));
    const server = new SessionServer({
      send: () => {},
      services: [{
        addr: A("OE8NOD", 1), name: "NODE",
        app: (r) => new NodeSession(r.call, nodeStore, "OENODE", "OE8NOD-1"),
        onConnect: nodeConnectThrough(node, dialer),
      }],
    });
    const q: Array<{ to: "server" | "client"; f: Ax25Frame }> = [];
    let rx = "";
    const client = new ConnectedLink(A("OE1USR"), A("OE8NOD", 1), { send: (f) => q.push({ to: "server", f }), deliver: (b) => { rx += dec(b); }, state: () => {} });
    (server as unknown as { o: { send: (f: Ax25Frame) => void } }).o.send = (f) => q.push({ to: "client", f });
    const pump = (g = 5000) => { while (q.length && g-- > 0) { const { to, f } = q.shift()!; if (to === "server") server.onFrame(f); else client.onReceive(f); } };
    client.connect(); pump();
    return { client, pump, rx: () => rx };
  }

  it("routes C <dest> onward and relays data transparently over the L4 circuit", () => {
    const { client, pump, rx } = setup(echoDialer);
    client.send(enc("C OE3FAR\r")); pump();
    expect(rx()).toContain("Connected to OE3FAR.");        // route resolved + onward circuit up

    client.send(enc("hello over netrom")); pump();          // now in transparent relay → echoed by the far peer
    expect(rx()).toContain("hello over netrom");
  });

  it("tells the user when there is no route", () => {
    const { client, pump, rx } = setup(echoDialer);
    client.send(enc("C ZZ9ZZ\r")); pump();
    expect(rx()).toContain("no route to ZZ9ZZ");
  });

  it("parses a BPQ connect script (optional port + callsign per hop)", () => {
    expect(parseConnectScript("C NODE1\nC 3 DB0XYZ")).toEqual([{ call: "NODE1" }, { port: 3, call: "DB0XYZ" }]);
    expect(parseConnectScript("  c oe8xbm  \n\n")).toEqual([{ call: "OE8XBM" }]); // case + blank lines
    expect(parseConnectScript("hello\nC")).toEqual([]);                           // non-C / bare C ignored
    expect(parseConnectScript("C 0 OE1ABC-7")).toEqual([{ port: 0, call: "OE1ABC-7" }]);
  });

  it("sequences a multi-hop connect script, ready after the last hop", () => {
    const enc2 = (s: string) => new TextEncoder().encode(s);
    const sent: string[] = [];
    let ready = false;
    const seq = new ConnectSequencer(parseConnectScript("C NODE1\nC DB0XYZ\nC OE8XBM"), {
      send: (l) => sent.push(l), onReady: () => { ready = true; }, onFail: () => {},
    });
    seq.start();
    expect(sent).toEqual(["C DB0XYZ"]);                 // hop 0 (NODE1) is the link's job; sequencer drives hop 1
    seq.feed(enc2("Connected to DB0XYZ\r"));
    expect(sent).toEqual(["C DB0XYZ", "C OE8XBM"]);      // advanced to hop 2
    expect(ready).toBe(false);
    seq.feed(enc2("Connected to OE8XBM\r"));
    expect(ready).toBe(true);                            // final hop up
  });

  it("is ready immediately for a single-hop (direct) script and fails on a busy node", () => {
    let ready = false, failed = "";
    const direct = new ConnectSequencer(parseConnectScript("C DB0XYZ"), { send: () => {}, onReady: () => { ready = true; }, onFail: () => {} });
    direct.start();
    expect(ready).toBe(true);

    const seq = new ConnectSequencer(parseConnectScript("C NODE1\nC DB0XYZ"), { send: () => {}, onReady: () => {}, onFail: (r) => { failed = r; } });
    seq.start();
    seq.feed(new TextEncoder().encode("DB0XYZ busy from OE1ABC\r"));
    expect(failed).toContain("busy");
  });

  it("returns the user to the node when the far end disconnects", () => {
    let closeHook: (() => void) | null = null;
    const dialer: CircuitDialer = (_r, hooks) => { closeHook = hooks.onClose; return { send: () => {}, disconnect: () => {} }; };
    const { client, pump, rx } = setup(dialer);
    client.send(enc("C OE3FAR\r")); pump();
    closeHook!();                                            // far end drops
    pump();
    expect(rx()).toContain("Disconnected from OE3FAR. Back at node.");
  });
});
