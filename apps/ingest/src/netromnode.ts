// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * netromnode.ts — the operator-local NET/ROM node RF wiring. Drives the pure `NetromNode`
 * engine over a KISS TNC: periodically transmits our NODES broadcast (UI → "NODES", PID 0xCF), consumes
 * inbound NODES broadcasts to learn routes, decays obsolescence, and mirrors the learned table + MHeard
 * up to the gateway (the shack node view reads them). The connected-mode node *session* (a user
 * connecting in and issuing C <dest> to route through us) rides the same KISS link and is validate-at-deploy.
 */
import {
  NetromNode,
  NetromCircuit,
  nodeConnectThrough,
  routeNetrom,
  serveNetromApp,
  encodeNetrom,
  decodeNetrom,
  NrOp,
  type LearnedRoute,
  type NodeStore,
  type NodeMheard,
  type CircuitDialer,
  type RelayController,
  type LineApp,
  Inp3Table,
  decodeRif,
  encodeRif,
  decodeL3rttFrame,
  encodeL3rttFrame,
  smoothRtt,
  ttFromRtt,
  INP_RIF,
  INP_TT_DIRECT,
  type Rip,
} from "@aprscaching/packet";
import { decodeFrame, parseAddr, addrStr, PID_NETROM, type Ax25Address } from "@aprscaching/ax25";
import type { FrameLink } from "./link.js";

const NODES_DST = { call: "NODES", ssid: 0 };

export interface NetromNodeOpts {
  mycall: string;
  alias: string;
  port?: string;
  broadcastMs?: number;
  decayMs?: number;
  pathQuality?: number;
  gatewayBase?: string;
  secret?: string; // mirror learned nodes + mheard to the gateway
  inp3?: boolean; // also speak INP3 (RIF learning, L3RTT probing, triggered updates) alongside NODES
}

export class NetromNodeRunner {
  private node: NetromNode;
  private port: string;
  private me: Ax25Address;
  private heard = new Map<string, NodeMheard>(); // callsign -> last-heard (for the node's MHeard list)
  private circuits: NetromCircuit[] = []; // active connect-through circuits (for inbound demux)
  private nextIdx = 1;
  private inboundApp?: (user: Ax25Address) => LineApp; // build a session for a station connecting a circuit TO us
  private inp3?: Inp3Table; // INP3 routes (opt-in), ranked by measured round-trip time
  private neighbors = new Map<string, { srtt: number | null; lastHeard: number }>(); // per-neighbour RTT + freshness
  private l3rttSeq = 0;
  private l3rttPending = new Map<number, number>(); // seq → send time (ms) for our outstanding probes
  constructor(
    private kiss: FrameLink,
    private o: NetromNodeOpts,
  ) {
    this.me = parseAddr(o.mycall);
    this.node = new NetromNode({ call: this.me, alias: o.alias }, { pathQuality: o.pathQuality });
    this.port = o.port ?? "kiss-tnc";
    if (o.inp3) this.inp3 = new Inp3Table();
  }

  /** Enable the L4 inbound session server: bind a station's inbound circuit to this app (the node CLI). */
  serveInbound(app: (user: Ax25Address) => LineApp): void {
    this.inboundApp = app;
  }

  /** The node's connect-through handler: `C <dest>` → route + bridge to an onward circuit. */
  connectThrough(): (dest: string, relay: RelayController) => void {
    return nodeConnectThrough(this.node, this.dialer);
  }

  /** Route an inbound ConnReq: a RETRANSMISSION (the peer missed our ConnAck) re-feeds the
   *  circuit that already accepted it — which re-acks — instead of opening a duplicate. */
  private acceptOrReack(
    pkt: import("@aprscaching/packet").NrPacket,
    neighbor: Ax25Address,
    sendPacket?: (bytes: Uint8Array) => void,
  ): void {
    const dup = this.circuits.find(
      (x) => x.remoteIndex === pkt.tp.circuitIndex && x.remoteId === pkt.tp.circuitId && x.state === "connected",
    );
    if (dup) return dup.onPacket(pkt.tp, pkt.info);
    this.acceptInbound(pkt, neighbor, sendPacket);
  }

  /** Accept an inbound NET/ROM circuit terminating at us and bind it to the node CLI. Replies
   *  route back to the reverse-path neighbour — via `sendPacket` when the circuit arrived over
   *  the connected inter-node link, as UI datagrams otherwise. */
  private acceptInbound(
    pkt: import("@aprscaching/packet").NrPacket,
    neighbor: Ax25Address,
    sendPacket?: (bytes: Uint8Array) => void,
  ): void {
    const origin = NetromCircuit.originOf(pkt.info);
    const user = origin?.user ?? pkt.net.origin;
    // replies are NETWORK-layer packets: they travel node-to-node, addressed to the circuit's
    // ORIGINATING NODE (a real peer drops packets whose L3 dest is the end user's callsign)
    const originNode = pkt.net.origin;
    const idx = this.nextIdx++ & 0xff;
    const circ = serveNetromApp({ index: idx, id: idx }, this.inboundApp!(user), {
      send: (p) => {
        const bytes = encodeNetrom({ net: { origin: this.me, dest: originNode, ttl: 25 }, tp: p.tp, info: p.info });
        if (sendPacket) return sendPacket(bytes);
        this.kiss.sendFrame({
          dst: neighbor,
          src: this.me,
          command: true,
          type: "UI",
          pf: false,
          pid: PID_NETROM,
          info: bytes,
        });
      },
      onConnect: this.connectThrough(), // a NET/ROM-connected user can C <dest> onward too
      onState: (s) => {
        if (s === "disconnected") this.circuits = this.circuits.filter((c) => c !== circ);
      },
    });
    this.circuits.push(circ);
    circ.onPacket(pkt.tp, pkt.info); // feed the ConnReq → the circuit accepts + greets
    console.log(`[netrom] inbound circuit from ${addrStr(user)} accepted`);
  }

  /** A CircuitDialer that opens a NET/ROM L4 circuit to a neighbour over KISS (validate-at-deploy on RF). */
  private dialer: CircuitDialer = (route, hooks) => {
    const idx = this.nextIdx++ & 0xff;
    const circuit = new NetromCircuit(
      {
        send: (p) => {
          // wrap the transport packet in the network header → UI/NETROM to the neighbour
          const bytes = encodeNetrom({ net: { origin: this.me, dest: route.dest, ttl: 25 }, tp: p.tp, info: p.info });
          this.kiss.sendFrame({
            dst: route.neighbor,
            src: this.me,
            command: true,
            type: "UI",
            pf: false,
            pid: PID_NETROM,
            info: bytes,
          });
        },
        deliver: (b) => hooks.onData(b),
        state: (s) => {
          if (s === "disconnected") {
            this.circuits = this.circuits.filter((c) => c !== circuit);
            hooks.onClose();
          }
        },
      },
      { index: idx, id: idx },
      { user: this.me, node: route.dest },
    );
    this.circuits.push(circuit);
    circuit.connect(4);
    return { send: (bytes) => circuit.send(bytes), disconnect: () => circuit.disconnect() };
  };

  /** A synchronous NodeStore over the live routing table + MHeard — feeds an inbound NodeSession CLI.
   *  When INP3 is on, its routes surface alongside NODES with a quality derived from tt (lower tt →
   *  higher presentation quality), so the node CLI shows one merged table. */
  nodeStore(activeUsers: () => string[]): NodeStore {
    const inpNodes = () =>
      (this.inp3?.list() ?? []).map((r) => ({ alias: r.alias, call: r.dest, quality: ttToQuality(r.tt) }));
    const inpRoutes = () =>
      (this.inp3?.list() ?? []).map((r) => ({ neighbor: r.neighbor, port: this.port, quality: ttToQuality(r.tt) }));
    return {
      nodes: () => [
        ...this.node.list().map((r) => ({ alias: r.alias, call: addrStr(r.dest), quality: r.quality })),
        ...inpNodes(),
      ],
      routes: () => [
        ...this.node
          .list()
          .map((r) => ({ neighbor: addrStr(r.neighbor), port: r.port ?? this.port, quality: r.quality })),
        ...inpRoutes(),
      ],
      users: () => activeUsers().map((call) => ({ call })),
      mheard: () => [...this.heard.values()].sort((a, b) => b.lastHeard - a.lastHeard).slice(0, 30),
      info: () => `${this.o.alias}:${this.o.mycall} — APRScaching NET/ROM node${this.inp3 ? " (INP3)" : ""}`,
    };
  }

  /** Learn from a neighbour's RIF: apply each RIP (never a route back to ourselves) over our measured tt
   *  to that neighbour, then emit a triggered update of whatever changed to every OTHER neighbour. */
  private consumeRif(info: Uint8Array, from: Ax25Address): void {
    if (!this.inp3) return;
    const rips = decodeRif(info);
    if (!rips) return;
    const nb = addrStr(from);
    this.ensureNeighbor(from);
    const linkTt = this.neighbors.get(nb)?.srtt ?? INP_TT_DIRECT;
    const mine = addrStr(this.me);
    let changed = 0;
    for (const r of rips) {
      if (addrStr(r.dest) === mine) continue; // never learn a route to ourselves (loop)
      if (this.inp3.applyRip(r, nb, ttFromRtt(linkTt)) !== "ignored") changed++;
    }
    if (changed) {
      console.log(`[inp3] learned ${changed} route change(s) from ${nb}`);
      this.emitTriggered();
    }
  }

  /** Register a station as an INP3 neighbour on first contact and seed it with our own reachability
   *  (a self-RIP) plus an immediate RTT probe, so two nodes converge without any static config. */
  private ensureNeighbor(addr: Ax25Address): boolean {
    if (!this.inp3) return false;
    const nb = addrStr(addr);
    if (this.neighbors.has(nb)) {
      this.neighbors.get(nb)!.lastHeard = Math.floor(Date.now() / 1000);
      return false;
    }
    this.neighbors.set(nb, { srtt: null, lastHeard: Math.floor(Date.now() / 1000) });
    this.sendRif(addr, [this.selfRip()]);
    this.probeNeighbor(addr);
    return true;
  }

  /** Our own node as a RIP: destination = us, zero hops, tt 0 so the receiver's cost is its link tt. */
  private selfRip(): Rip {
    return { dest: this.me, hops: 0, tt: 0, alias: this.o.alias };
  }

  /** Handle an L3RTT probe: our own returning probe measures the round trip; a foreign probe is echoed
   *  back to its sender so THEY can measure. */
  private onL3rtt(
    probe: { origin: Ax25Address; rtt: { seq: number; origin: string; alias: string } },
    from: Ax25Address,
  ): void {
    if (!this.inp3) return;
    if (probe.rtt.origin === this.o.mycall) {
      const sent = this.l3rttPending.get(probe.rtt.seq);
      if (sent != null) {
        this.l3rttPending.delete(probe.rtt.seq);
        const rttMs = Date.now() - sent;
        const sample = Math.max(INP_TT_DIRECT, Math.round(rttMs / 10)); // 10 ms units
        const nb = addrStr(from);
        const cur = this.neighbors.get(nb);
        this.neighbors.set(nb, {
          srtt: smoothRtt(cur?.srtt ?? null, sample),
          lastHeard: Math.floor(Date.now() / 1000),
        });
      }
      return;
    }
    // foreign probe — echo it straight back to the neighbour we heard it from
    this.kiss.sendFrame({
      dst: from,
      src: this.me,
      command: true,
      type: "UI",
      pf: false,
      pid: PID_NETROM,
      info: encodeL3rttFrame(probe.origin, probe.rtt),
    });
  }

  /** Send a triggered update: advertise the changed routes to every neighbour, applying split horizon
   *  (never advertise a route back to the neighbour we reach that destination through). */
  private emitTriggered(): void {
    if (!this.inp3) return;
    const dirty = this.inp3.drainDirty();
    if (!dirty.length) return;
    for (const nb of this.neighbors.keys()) {
      const rips = dirty.filter((r) => this.inp3!.best(addrStr(r.dest))?.neighbor !== nb);
      if (rips.length) this.sendRif(parseAddr(nb), rips);
    }
  }

  /** Advertise our full table (self-RIP + every known route, split-horizon) to every neighbour — the
   *  periodic refresh that keeps routes from ageing out and re-seeds a neighbour that just came up. */
  private advertiseAll(): void {
    if (!this.inp3) return;
    const all = this.inp3.snapshot();
    for (const nb of this.neighbors.keys()) {
      const rips = [this.selfRip(), ...all.filter((r) => this.inp3!.best(addrStr(r.dest))?.neighbor !== nb)];
      this.sendRif(parseAddr(nb), rips);
    }
  }

  /** Send a RIF (routing information frame) carrying `rips` to one neighbour. */
  private sendRif(to: Ax25Address, rips: Rip[]): void {
    this.kiss.sendFrame({
      dst: to,
      src: this.me,
      command: true,
      type: "UI",
      pf: false,
      pid: PID_NETROM,
      info: encodeRif(rips),
    });
  }

  /** Probe every known neighbour's round-trip time with an L3RTT frame (INP3 metric maintenance). */
  private probeNeighbors(): void {
    if (!this.inp3) return;
    for (const nb of this.neighbors.keys()) this.probeNeighbor(parseAddr(nb));
    // drop stale outstanding probes so the map can't grow unbounded on a lossy link
    const cutoff = Date.now() - 180_000;
    for (const [seq, t] of this.l3rttPending) if (t < cutoff) this.l3rttPending.delete(seq);
  }

  /** Send one L3RTT probe to a neighbour and remember when, so the echo measures the round trip. */
  private probeNeighbor(to: Ax25Address): void {
    if (!this.inp3) return;
    const seq = ++this.l3rttSeq;
    this.l3rttPending.set(seq, Date.now());
    this.kiss.sendFrame({
      dst: to,
      src: this.me,
      command: true,
      type: "UI",
      pf: false,
      pid: PID_NETROM,
      info: encodeL3rttFrame(this.me, { origin: this.o.mycall, seq, alias: this.o.alias }),
    });
  }

  start(): void {
    const bMs = this.o.broadcastMs ?? 300_000; // NET/ROM default NODES interval ≈ 5 min
    const dMs = this.o.decayMs ?? bMs;
    this.broadcast();
    setInterval(() => this.broadcast(), bMs);
    setInterval(() => this.node.decay(), dMs);
    if (this.inp3) {
      // INP3 maintenance: probe neighbour RTTs, re-advertise the table, and expire routes we haven't
      // reheard within the window.
      const rttMs = 60_000;
      setInterval(() => this.probeNeighbors(), rttMs);
      setInterval(() => this.advertiseAll(), bMs);
      const staleMs = bMs * 3;
      setInterval(() => {
        const cutoff = Math.floor(Date.now() / 1000) - staleMs / 1000;
        this.inp3!.expire((r) => (this.neighbors.get(r.neighbor)?.lastHeard ?? 0) < cutoff);
      }, bMs).unref?.();
      console.log(`[inp3] enabled — RIF learning, L3RTT probing, triggered updates on ${this.port}`);
    }
    setInterval(() => {
      for (const c of this.circuits) c.poll();
    }, 1000); // drive circuit T1 retransmit/teardown
    // evict stale MHeard entries so the map doesn't grow for the life of the process.
    const heardTtl = 24 * 3600; // seconds
    setInterval(() => {
      const cutoff = Math.floor(Date.now() / 1000) - heardTtl;
      for (const [cs, m] of this.heard) if (m.lastHeard < cutoff) this.heard.delete(cs);
    }, 3_600_000).unref?.();
    console.log(`[netrom] node ${this.o.alias}:${this.o.mycall} active on ${this.port}`);
  }

  /** Feed a raw inbound AX.25 frame (wire this to KissTnc.onRaw). Learns from NODES broadcasts. */
  onRaw(bytes: Uint8Array): void {
    const f = decodeFrame(bytes);
    if (!f) return;
    this.heard.set(addrStr(f.src), { call: addrStr(f.src), port: this.port, lastHeard: Math.floor(Date.now() / 1000) });
    if (f.type !== "UI" || f.pid !== PID_NETROM || !f.info) return;

    // INP3 (opt-in): a directed RIF (info[0] = 0xFF, sent to us, not flooded to "NODES") carries the
    // neighbour's routing table by measured round-trip time; an L3RTT frame is a latency probe.
    if (this.inp3 && f.info[0] === INP_RIF && f.dst.call !== NODES_DST.call) {
      this.consumeRif(f.info, f.src);
      return;
    }
    if (this.inp3 && f.info[0] !== INP_RIF) {
      const probe = decodeL3rttFrame(f.info);
      if (probe) {
        this.onL3rtt(probe, f.src);
        return;
      }
    }

    // A directed NET/ROM frame (not the "NODES" broadcast): switch it — deliver locally to its circuit,
    // transit-forward it toward its destination, or drop (TTL/no-route/loop).
    if (f.dst.call !== NODES_DST.call) {
      // TheNet-lineage neighbours (TNN) address their NODES records to the REGISTERED
      // NEIGHBOUR's callsign instead of "NODES" — same 0xFF payload, directed addressing.
      // 0xFF can never open a valid network header, so the lead byte is unambiguous.
      if (f.info[0] === 0xff) {
        const learned = this.node.consume(f.info, f.src, this.port);
        if (learned) {
          console.log(`[netrom] learned ${learned} route(s) from ${addrStr(f.src)} (directed)`);
          void this.mirror();
        }
        return;
      }
      const pkt = decodeNetrom(f.info);
      if (!pkt) return;
      const decision = routeNetrom(pkt, this.node, this.me);
      if (decision.action === "local") {
        const c = this.circuits.find((x) => x.localIndex === pkt.tp.circuitIndex && x.localId === pkt.tp.circuitId);
        if (c)
          c.onPacket(pkt.tp, pkt.info); // demux to the owning circuit
        else if (pkt.tp.opcode === NrOp.ConnReq && this.inboundApp) this.acceptOrReack(pkt, f.src); // L4 inbound session
      } else if (decision.action === "forward") {
        this.kiss.sendFrame({
          dst: decision.neighbor,
          src: this.me,
          command: true,
          type: "UI",
          pf: false,
          pid: PID_NETROM,
          info: encodeNetrom(decision.packet),
        });
      } else if (decision.reason !== "no-route") {
        console.log(`[netrom] dropped transit to ${addrStr(pkt.net.dest)} (${decision.reason})`);
      }
      return;
    }
    const learned = this.node.consume(f.info, f.src, this.port);
    if (learned) {
      console.log(`[netrom] learned ${learned} route(s) from ${addrStr(f.src)}`);
      void this.mirror();
    }
    // A NODES broadcaster is a node on our channel — adopt it as an INP3 neighbour (measure its RTT,
    // exchange RIFs), so INP3 bootstraps off NODES discovery without any static neighbour config.
    if (this.inp3) this.ensureNeighbor(f.src);
  }

  /** Process a NET/ROM network packet that arrived INSIDE a connected L2 session to our node
   *  call (I-frame, PID 0xCF). Real neighbours — BPQ and the TheNet lineage — run their L4
   *  circuit traffic (and TheNet its routing records) over the inter-node link rather than UI
   *  datagrams; replies belong on the same session via `reply`. */
  onLinkNetrom(neighbor: Ax25Address, packet: Uint8Array, reply: (bytes: Uint8Array) => void): void {
    if (!packet.length) return;
    if (packet[0] === 0xff) {
      // NODES records over the link (TheNet-style connected routing exchange)
      const learned = this.node.consume(packet, neighbor, this.port);
      if (learned) {
        console.log(`[netrom] learned ${learned} route(s) from ${addrStr(neighbor)} (link)`);
        void this.mirror();
      }
      return;
    }
    const pkt = decodeNetrom(packet);
    if (!pkt) return;
    const decision = routeNetrom(pkt, this.node, this.me);
    if (decision.action === "local") {
      const c = this.circuits.find((x) => x.localIndex === pkt.tp.circuitIndex && x.localId === pkt.tp.circuitId);
      if (c) c.onPacket(pkt.tp, pkt.info);
      else if (pkt.tp.opcode === NrOp.ConnReq && this.inboundApp) this.acceptOrReack(pkt, neighbor, reply);
    } else if (decision.action === "forward") {
      this.kiss.sendFrame({
        dst: decision.neighbor,
        src: this.me,
        command: true,
        type: "UI",
        pf: false,
        pid: PID_NETROM,
        info: encodeNetrom(decision.packet),
      });
    } else if (decision.reason !== "no-route") {
      console.log(`[netrom] dropped link transit to ${addrStr(pkt.net.dest)} (${decision.reason})`);
    }
  }

  /** Transmit our NODES broadcast frame(s). */
  private broadcast(): void {
    for (const info of this.node.broadcast())
      this.kiss.sendFrame({
        dst: NODES_DST,
        src: parseAddr(this.o.mycall),
        command: true,
        type: "UI",
        pf: false,
        pid: PID_NETROM,
        info,
      });
  }

  /** Mirror the learned NODES table + MHeard to the gateway node surface (best-effort). INP3 routes are
   *  not mirrored here (the gateway table keys on dest, which NODES already owns) — they surface in the
   *  node CLI's merged table via nodeStore(). */
  private async mirror(): Promise<void> {
    if (!this.o.gatewayBase || !this.o.secret) return;
    const post = (path: string, body: unknown) =>
      fetch(`${this.o.gatewayBase}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ingest-secret": this.o.secret! },
        body: JSON.stringify(body),
      }).catch(() => {});
    for (const r of this.node.list()) await this.postNode(post, r);
  }
  private postNode(post: (p: string, b: unknown) => Promise<unknown>, r: LearnedRoute): Promise<unknown> {
    return post("/api/node/nodes", {
      dest: addrStr(r.dest),
      alias: r.alias,
      neighbor: addrStr(r.neighbor),
      quality: r.quality,
      port: r.port ?? this.port,
    });
  }
}

/** Present an INP3 tt (10 ms round-trip, lower = better) as a NET/ROM-style 0–255 quality for the
 *  merged node table: a direct/fast route (tt≈1) → ~250, degrading with latency. Presentation only —
 *  INP3 routing decisions stay on the native tt metric. */
function ttToQuality(tt: number): number {
  return Math.max(1, Math.min(255, Math.round(255 - Math.min(tt, 250))));
}
