// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * netromnode.ts — the operator-local NET/ROM node RF wiring. Drives the pure `NetromNode`
 * engine over a KISS TNC: periodically transmits our NODES broadcast (UI → "NODES", PID 0xCF), consumes
 * inbound NODES broadcasts to learn routes, decays obsolescence, and mirrors the learned table + MHeard
 * up to the gateway (the workbench node view reads them). The connected-mode node *session* (a user
 * connecting in and issuing C <dest> to route through us) rides the same KISS link and is validate-at-deploy.
 */
import {
  NetromNode, NetromCircuit, nodeConnectThrough, routeNetrom, serveNetromApp, encodeNetrom, decodeNetrom, NrOp,
  type LearnedRoute, type NodeStore, type NodeMheard, type CircuitDialer, type RelayController, type LineApp,
} from "@aprsweb/packet";
import { decodeFrame, parseAddr, addrStr, PID_NETROM, type Ax25Address } from "@aprsweb/ax25";
import type { KissTnc } from "./kiss.js";

const NODES_DST = { call: "NODES", ssid: 0 };

export interface NetromNodeOpts {
  mycall: string; alias: string; port?: string;
  broadcastMs?: number; decayMs?: number; pathQuality?: number;
  gatewayBase?: string; secret?: string;   // mirror learned nodes + mheard to the gateway
}

export class NetromNodeRunner {
  private node: NetromNode;
  private port: string;
  private me: Ax25Address;
  private heard = new Map<string, NodeMheard>();   // callsign -> last-heard (for the node's MHeard list)
  private circuits: NetromCircuit[] = [];          // active connect-through circuits (for inbound demux)
  private nextIdx = 1;
  private inboundApp?: (user: Ax25Address) => LineApp;   // build a session for a station connecting a circuit TO us
  constructor(private kiss: KissTnc, private o: NetromNodeOpts) {
    this.me = parseAddr(o.mycall);
    this.node = new NetromNode({ call: this.me, alias: o.alias }, { pathQuality: o.pathQuality });
    this.port = o.port ?? "kiss-tnc";
  }

  /** Enable the L4 inbound session server: bind a station's inbound circuit to this app (the node CLI). */
  serveInbound(app: (user: Ax25Address) => LineApp): void { this.inboundApp = app; }

  /** The node's connect-through handler: `C <dest>` → route + bridge to an onward circuit. */
  connectThrough(): (dest: string, relay: RelayController) => void { return nodeConnectThrough(this.node, this.dialer); }

  /** Accept an inbound NET/ROM circuit terminating at us and bind it to the node CLI. Replies
   *  route back to the reverse-path neighbour; the user gets full node behaviour incl. onward connect. */
  private acceptInbound(pkt: import("@aprsweb/packet").NrPacket, neighbor: Ax25Address): void {
    const origin = NetromCircuit.originOf(pkt.info);
    const user = origin?.user ?? pkt.net.origin;
    const idx = this.nextIdx++ & 0xff;
    const circ = serveNetromApp({ index: idx, id: idx }, this.inboundApp!(user), {
      send: (p) => {
        const bytes = encodeNetrom({ net: { origin: this.me, dest: user, ttl: 25 }, tp: p.tp, info: p.info });
        this.kiss.sendFrame({ dst: neighbor, src: this.me, command: true, type: "UI", pf: false, pid: PID_NETROM, info: bytes });
      },
      onConnect: this.connectThrough(),                // a NET/ROM-connected user can C <dest> onward too
      onState: (s) => { if (s === "disconnected") this.circuits = this.circuits.filter((c) => c !== circ); },
    });
    this.circuits.push(circ);
    circ.onPacket(pkt.tp, pkt.info);                    // feed the ConnReq → the circuit accepts + greets
    console.log(`[netrom] inbound circuit from ${addrStr(user)} accepted`);
  }

  /** A CircuitDialer that opens a NET/ROM L4 circuit to a neighbour over KISS (validate-at-deploy on RF). */
  private dialer: CircuitDialer = (route, hooks) => {
    const idx = this.nextIdx++ & 0xff;
    const circuit = new NetromCircuit({
      send: (p) => {                                 // wrap the transport packet in the network header → UI/NETROM to the neighbour
        const bytes = encodeNetrom({ net: { origin: this.me, dest: route.dest, ttl: 25 }, tp: p.tp, info: p.info });
        this.kiss.sendFrame({ dst: route.neighbor, src: this.me, command: true, type: "UI", pf: false, pid: PID_NETROM, info: bytes });
      },
      deliver: (b) => hooks.onData(b),
      state: (s) => { if (s === "disconnected") { this.circuits = this.circuits.filter((c) => c !== circuit); hooks.onClose(); } },
    }, { index: idx, id: idx }, { user: this.me, node: route.dest });
    this.circuits.push(circuit);
    circuit.connect(4);
    return { send: (bytes) => circuit.send(bytes), disconnect: () => circuit.disconnect() };
  };

  /** A synchronous NodeStore over the live routing table + MHeard — feeds an inbound NodeSession CLI. */
  nodeStore(activeUsers: () => string[]): NodeStore {
    return {
      nodes: () => this.node.list().map((r) => ({ alias: r.alias, call: addrStr(r.dest), quality: r.quality })),
      routes: () => this.node.list().map((r) => ({ neighbor: addrStr(r.neighbor), port: r.port ?? this.port, quality: r.quality })),
      users: () => activeUsers().map((call) => ({ call })),
      mheard: () => [...this.heard.values()].sort((a, b) => b.lastHeard - a.lastHeard).slice(0, 30),
      info: () => `${this.o.alias}:${this.o.mycall} — APRScaching NET/ROM node`,
    };
  }

  start(): void {
    const bMs = this.o.broadcastMs ?? 300_000;   // NET/ROM default NODES interval ≈ 5 min
    const dMs = this.o.decayMs ?? bMs;
    this.broadcast();
    setInterval(() => this.broadcast(), bMs);
    setInterval(() => this.node.decay(), dMs);
    console.log(`[netrom] node ${this.o.alias}:${this.o.mycall} active on ${this.port}`);
  }

  /** Feed a raw inbound AX.25 frame (wire this to KissTnc.onRaw). Learns from NODES broadcasts. */
  onRaw(bytes: Uint8Array): void {
    const f = decodeFrame(bytes);
    if (!f) return;
    this.heard.set(addrStr(f.src), { call: addrStr(f.src), port: this.port, lastHeard: Math.floor(Date.now() / 1000) });
    if (f.type !== "UI" || f.pid !== PID_NETROM || !f.info) return;

    // A directed NET/ROM frame (not the "NODES" broadcast): switch it — deliver locally to its circuit,
    // transit-forward it toward its destination, or drop (TTL/no-route/loop). F2.
    if (f.dst.call !== NODES_DST.call) {
      const pkt = decodeNetrom(f.info);
      if (!pkt) return;
      const decision = routeNetrom(pkt, this.node, this.me);
      if (decision.action === "local") {
        const c = this.circuits.find((x) => x.localIndex === pkt.tp.circuitIndex && x.localId === pkt.tp.circuitId);
        if (c) c.onPacket(pkt.tp, pkt.info);            // demux to the owning circuit
        else if (pkt.tp.opcode === NrOp.ConnReq && this.inboundApp) this.acceptInbound(pkt, f.src);  // L4 inbound session
      } else if (decision.action === "forward") {
        this.kiss.sendFrame({ dst: decision.neighbor, src: this.me, command: true, type: "UI", pf: false, pid: PID_NETROM, info: encodeNetrom(decision.packet) });
      } else if (decision.reason !== "no-route") {
        console.log(`[netrom] dropped transit to ${addrStr(pkt.net.dest)} (${decision.reason})`);
      }
      return;
    }
    const learned = this.node.consume(f.info, f.src, this.port);
    if (learned) { console.log(`[netrom] learned ${learned} route(s) from ${addrStr(f.src)}`); void this.mirror(); }
  }

  /** Transmit our NODES broadcast frame(s). */
  private broadcast(): void {
    for (const info of this.node.broadcast())
      this.kiss.sendFrame({ dst: NODES_DST, src: parseAddr(this.o.mycall), command: true, type: "UI", pf: false, pid: PID_NETROM, info });
  }

  /** Mirror the learned table + MHeard to the gateway node surface (best-effort). */
  private async mirror(): Promise<void> {
    if (!this.o.gatewayBase || !this.o.secret) return;
    const post = (path: string, body: unknown) =>
      fetch(`${this.o.gatewayBase}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-ingest-secret": this.o.secret! }, body: JSON.stringify(body) }).catch(() => {});
    for (const r of this.node.list()) await this.postNode(post, r);
  }
  private postNode(post: (p: string, b: unknown) => Promise<unknown>, r: LearnedRoute): Promise<unknown> {
    return post("/api/node/nodes", { dest: addrStr(r.dest), alias: r.alias, neighbor: addrStr(r.neighbor), quality: r.quality, port: r.port ?? this.port });
  }
}
