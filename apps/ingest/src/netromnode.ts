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
import {
  decodeFrame,
  parseAddr,
  addrStr,
  sameAddr,
  PID_NETROM,
  type Ax25Address,
  type Ax25Frame,
} from "@aprscaching/ax25";
import type { FrameLink } from "./link.js";
import { gatewayFetch } from "./gatewayauth.js";
import { NETROM_BROADCAST_DEFAULT_MS } from "./connected.js";
import { TokenBucket, TX_LIMITS } from "./txlimit.js";

const NODES_DST = { call: "NODES", ssid: 0 };
/** Routing changes are gathered for this long and then mirrored to the gateway in one request. */
const MIRROR_MS = 30_000;
/** Stations kept for the MHeard list; past it the least recently heard goes. */
const MAX_HEARD = 500;
/** Open circuits at once, inbound and dialled; a ConnReq past it is not answered. */
const MAX_CIRCUITS = 64;
/** INP3 neighbours, measured or still being probed; each one costs probes and RIFs every round. */
const MAX_INP3_NEIGHBORS = 16;
/** A candidate neighbour that has not answered a probe in this long is dropped. */
const INP3_PROBE_TIMEOUT_MS = 180_000;

interface Inp3Neighbor {
  /** Smoothed round trip in 10 ms units; null until the neighbour answers a probe. */
  srtt: number | null;
  lastHeard: number; // seconds
  since: number; // ms, when it was first heard
}

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
  /** Paces what the node transmits on its own account in answer to what it hears: INP3 RIFs and L3RTT
   *  probes and echoes, and transit forwards. Defaults to the `netrom` path's settings. */
  txLimit?: { burst: number; refillSec: number };
  mirrorMs?: number;
}

/** One open circuit and the node at its far end: a transport packet reaches it only from that node. */
interface OpenCircuit {
  c: NetromCircuit;
  peer: Ax25Address;
}

export class NetromNodeRunner {
  private node: NetromNode;
  private port: string;
  private me: Ax25Address;
  private heard = new Map<string, NodeMheard>(); // callsign -> last-heard (for the node's MHeard list)
  private circuits: OpenCircuit[] = []; // active circuits (for inbound demux)
  private inboundApp?: (user: Ax25Address) => LineApp; // build a session for a station connecting a circuit TO us
  private inp3?: Inp3Table; // INP3 routes (opt-in), ranked by measured round-trip time
  private neighbors = new Map<string, Inp3Neighbor>(); // per-neighbour RTT + freshness
  private l3rttSeq = 0;
  private l3rttPending = new Map<number, { at: number; to: string }>(); // our outstanding probes by seq
  private tx: TokenBucket;
  private strangerTx: TokenBucket; // the share of `tx` open to stations that are not neighbours
  private held = 0; // frames the bucket dropped since the last log line
  private heldLoggedAt = 0;
  private mirrored = new Map<string, string>(); // dest → the record last mirrored to the gateway
  private mirrorTimer?: ReturnType<typeof setTimeout>;
  private mirroring = false;
  constructor(
    private kiss: FrameLink,
    private o: NetromNodeOpts,
  ) {
    this.me = parseAddr(o.mycall);
    this.node = new NetromNode({ call: this.me, alias: o.alias }, { pathQuality: o.pathQuality });
    this.port = o.port ?? "kiss-tnc";
    if (o.inp3) this.inp3 = new Inp3Table();
    const lim = o.txLimit ?? { burst: TX_LIMITS.netrom.burst, refillSec: TX_LIMITS.netrom.refillSec };
    this.tx = new TokenBucket(lim);
    // Half the burst and half the rate: a flood of forged sources spends only this share, and the rest of
    // the bucket stays for the node's neighbours.
    this.strangerTx = new TokenBucket({ burst: Math.max(1, Math.floor(lim.burst / 2)), refillSec: lim.refillSec * 2 });
  }

  /** Whether a station is one of the node's neighbours: the next hop of a route in the NODES table (INP3 on
   *  or off), or an INP3 neighbour that has answered our probe. */
  private isNeighbor(on: Ax25Address): boolean {
    return this.node.isNeighbor(on) || this.isMeasured(on);
  }

  /** Whether a station is an INP3 neighbour that has answered our probe. */
  private isMeasured(on: Ax25Address): boolean {
    return this.neighbors.get(addrStr(on))?.srtt != null;
  }

  /** Transmit a frame the node sends in answer to what it heard, when the bucket allows; dropped otherwise.
   *  Unless the frame is sent on account of a neighbour (`neighbour`), it also draws from the strangers'
   *  share. */
  private sendPaced(frame: Ax25Frame, neighbour: boolean): boolean {
    if ((neighbour || this.strangerTx.take()) && this.tx.take()) {
      this.kiss.sendFrame(frame);
      return true;
    }
    this.held++;
    const now = Date.now();
    if (now - this.heldLoggedAt >= 60_000) {
      console.log("[netrom] %s frame(s) dropped by the transmit bucket (NETROM_TX_BURST / _REFILL_SEC)", this.held);
      this.held = 0;
      this.heldLoggedAt = now;
    }
    return false;
  }

  /** A free local circuit index and a random id, or null when the circuit table is full. The random id
   *  keeps a station that guesses the index from reaching another user's circuit. */
  private allocCircuit(): { index: number; id: number } | null {
    if (this.circuits.length >= MAX_CIRCUITS) return null;
    const used = new Set(this.circuits.map((x) => x.c.localIndex));
    let index = 1;
    while (used.has(index)) index++;
    return { index, id: crypto.getRandomValues(new Uint8Array(1))[0]! };
  }

  private findCircuit(tp: { circuitIndex: number; circuitId: number }, origin: Ax25Address): NetromCircuit | undefined {
    return this.circuits.find(
      (x) => x.c.localIndex === tp.circuitIndex && x.c.localId === tp.circuitId && sameAddr(x.peer, origin),
    )?.c;
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
      (x) =>
        x.c.remoteIndex === pkt.tp.circuitIndex &&
        x.c.remoteId === pkt.tp.circuitId &&
        x.c.state === "connected" &&
        sameAddr(x.peer, pkt.net.origin),
    )?.c;
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
    const id = this.allocCircuit();
    if (!id) {
      console.log("[netrom] inbound circuit from %s not answered: %s circuits open", addrStr(user), MAX_CIRCUITS);
      return;
    }
    const circ = serveNetromApp(id, this.inboundApp!(user), {
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
        if (s === "disconnected") this.circuits = this.circuits.filter((x) => x.c !== circ);
      },
    });
    this.circuits.push({ c: circ, peer: originNode });
    circ.onPacket(pkt.tp, pkt.info); // feed the ConnReq → the circuit accepts + greets
    console.log("[netrom] inbound circuit from %s accepted", addrStr(user));
  }

  /** A CircuitDialer that opens a NET/ROM L4 circuit to a neighbour over KISS (validate-at-deploy on RF). */
  private dialer: CircuitDialer = (route, hooks) => {
    const id = this.allocCircuit();
    if (!id) {
      queueMicrotask(hooks.onClose); // after the caller has attached the relay, so its teardown detaches it
      return { send: () => {}, disconnect: () => {} };
    }
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
            this.circuits = this.circuits.filter((x) => x.c !== circuit);
            hooks.onClose();
          }
        },
      },
      id,
      { user: this.me, node: route.dest },
    );
    this.circuits.push({ c: circuit, peer: route.dest });
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
    // routes are taken only from a neighbour that has answered our probe: its cost is then measured, and
    // a station that only sends RIFs cannot fill the table
    const linkTt = this.neighbors.get(nb)?.srtt;
    if (linkTt == null) return;
    const mine = addrStr(this.me);
    let changed = 0;
    for (const r of rips) {
      if (addrStr(r.dest) === mine) continue; // never learn a route to ourselves (loop)
      if (this.inp3.applyRip(r, nb, ttFromRtt(linkTt)) !== "ignored") changed++;
    }
    if (changed) {
      console.log("[inp3] learned %s route change(s) from %s", changed, nb);
      this.emitTriggered();
    }
  }

  /** Take a station as a candidate INP3 neighbour on first contact and probe its round trip; it becomes a
   *  neighbour (gets our table, may teach routes) once it answers, so two nodes converge without static
   *  config. The set is capped: a new candidate displaces the oldest unanswered one, never a measured
   *  neighbour, so forged sources cost at most the cap's worth of probes, paced by the bucket. */
  private ensureNeighbor(addr: Ax25Address): void {
    if (!this.inp3) return;
    const nb = addrStr(addr);
    const now = Date.now();
    const cur = this.neighbors.get(nb);
    if (cur) {
      cur.lastHeard = Math.floor(now / 1000);
      return;
    }
    if (this.neighbors.size >= MAX_INP3_NEIGHBORS) {
      const candidate = [...this.neighbors].find(([, n]) => n.srtt == null)?.[0];
      if (candidate == null) return; // full of measured neighbours
      this.neighbors.delete(candidate);
    }
    this.neighbors.set(nb, { srtt: null, lastHeard: Math.floor(now / 1000), since: now });
    this.probeNeighbor(addr);
  }

  /** Our self-RIP and every route not reached through `nb` (split horizon), to one neighbour. */
  private advertiseTo(nb: string): void {
    const all = this.inp3!.snapshot();
    this.sendRif(parseAddr(nb), [
      this.selfRip(),
      ...all.filter((r) => this.inp3!.best(addrStr(r.dest))?.neighbor !== nb),
    ]);
  }

  /** Neighbours that have answered a probe — the ones routes are exchanged with. */
  private measured(): string[] {
    return [...this.neighbors].filter(([, n]) => n.srtt != null).map(([k]) => k);
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
      const nb = addrStr(from);
      const sent = this.l3rttPending.get(probe.rtt.seq);
      const cur = this.neighbors.get(nb);
      // only the station we probed, answering that probe, is measured
      if (sent == null || sent.to !== nb || !cur) return;
      this.l3rttPending.delete(probe.rtt.seq);
      const rttMs = Date.now() - sent.at;
      const sample = Math.max(INP_TT_DIRECT, Math.round(rttMs / 10)); // 10 ms units
      const first = cur.srtt == null;
      cur.srtt = smoothRtt(cur.srtt, sample);
      cur.lastHeard = Math.floor(Date.now() / 1000);
      if (first) this.advertiseTo(nb); // a new neighbour gets our table straight away
      return;
    }
    // foreign probe — echo it straight back to the neighbour we heard it from
    this.sendPaced(
      {
        dst: from,
        src: this.me,
        command: true,
        type: "UI",
        pf: false,
        pid: PID_NETROM,
        info: encodeL3rttFrame(probe.origin, probe.rtt),
      },
      this.isNeighbor(from),
    );
  }

  /** Send a triggered update: advertise the changed routes to every neighbour, applying split horizon
   *  (never advertise a route back to the neighbour we reach that destination through). */
  private emitTriggered(): void {
    if (!this.inp3) return;
    const dirty = this.inp3.drainDirty();
    if (!dirty.length) return;
    for (const nb of this.measured()) {
      const rips = dirty.filter((r) => this.inp3!.best(addrStr(r.dest))?.neighbor !== nb);
      if (rips.length) this.sendRif(parseAddr(nb), rips);
    }
  }

  /** Advertise our full table (self-RIP + every known route, split-horizon) to every neighbour — the
   *  periodic refresh that keeps routes from ageing out and re-seeds a neighbour that just came up. */
  private advertiseAll(): void {
    if (!this.inp3) return;
    for (const nb of this.measured()) this.advertiseTo(nb);
  }

  /** Send a RIF (routing information frame) carrying `rips` to one neighbour. */
  private sendRif(to: Ax25Address, rips: Rip[]): void {
    this.sendPaced(
      {
        dst: to,
        src: this.me,
        command: true,
        type: "UI",
        pf: false,
        pid: PID_NETROM,
        info: encodeRif(rips),
      },
      this.isMeasured(to),
    );
  }

  /** Probe every known neighbour's round-trip time with an L3RTT frame (INP3 metric maintenance). */
  private probeNeighbors(): void {
    if (!this.inp3) return;
    const cutoff = Date.now() - INP3_PROBE_TIMEOUT_MS;
    for (const [nb, n] of this.neighbors) {
      if (n.srtt == null && n.since < cutoff)
        this.neighbors.delete(nb); // never answered
      else this.probeNeighbor(parseAddr(nb));
    }
    // drop stale outstanding probes so the map can't grow unbounded on a lossy link
    for (const [seq, p] of this.l3rttPending) if (p.at < cutoff) this.l3rttPending.delete(seq);
  }

  /** Send one L3RTT probe to a neighbour and remember when, so the echo measures the round trip. */
  private probeNeighbor(to: Ax25Address): void {
    if (!this.inp3) return;
    const seq = ++this.l3rttSeq;
    const sent = this.sendPaced(
      {
        dst: to,
        src: this.me,
        command: true,
        type: "UI",
        pf: false,
        pid: PID_NETROM,
        info: encodeL3rttFrame(this.me, { origin: this.o.mycall, seq, alias: this.o.alias }),
      },
      this.isMeasured(to),
    );
    if (sent) this.l3rttPending.set(seq, { at: Date.now(), to: addrStr(to) });
  }

  start(): void {
    const bMs = Math.max(this.o.broadcastMs ?? NETROM_BROADCAST_DEFAULT_MS, 60_000); // a NODES broadcast keys the transmitter
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
        for (const [nb, n] of this.neighbors) if (n.lastHeard < cutoff) this.neighbors.delete(nb);
        this.inp3!.expire((r) => (this.neighbors.get(r.neighbor)?.lastHeard ?? 0) < cutoff);
      }, bMs).unref?.();
      console.log("[inp3] enabled — RIF learning, L3RTT probing, triggered updates on %s", this.port);
    }
    setInterval(() => {
      for (const x of this.circuits) x.c.poll();
    }, 1000); // drive circuit T1 retransmit/teardown
    // evict stale MHeard entries so the map doesn't grow for the life of the process.
    const heardTtl = 24 * 3600; // seconds
    setInterval(() => {
      const cutoff = Math.floor(Date.now() / 1000) - heardTtl;
      for (const [cs, m] of this.heard) if (m.lastHeard < cutoff) this.heard.delete(cs);
    }, 3_600_000).unref?.();
    console.log("[netrom] node %s:%s active on %s", this.o.alias, this.o.mycall, this.port);
  }

  /** Feed a raw inbound AX.25 frame (wire this to KissTnc.onRaw). Learns from NODES broadcasts. */
  onRaw(bytes: Uint8Array): void {
    const f = decodeFrame(bytes);
    if (!f) return;
    const src = addrStr(f.src);
    this.heard.delete(src); // re-inserted last, so the first entry is always the least recently heard
    this.heard.set(src, { call: src, port: this.port, lastHeard: Math.floor(Date.now() / 1000) });
    if (this.heard.size > MAX_HEARD) this.heard.delete(this.heard.keys().next().value!);
    if (f.type !== "UI" || f.pid !== PID_NETROM || !f.info) return;
    // Past the NODES broadcast, a NET/ROM frame is ours only when sent to our node call: one heard between
    // two other stations is not ours to learn from, answer or switch onward.
    if (f.dst.call !== NODES_DST.call && !sameAddr(f.dst, this.me)) return;

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
          console.log("[netrom] learned %s route(s) from %s (directed)", learned, addrStr(f.src));
          this.scheduleMirror();
        }
        return;
      }
      const pkt = decodeNetrom(f.info);
      if (!pkt) return;
      const decision = routeNetrom(pkt, this.node, this.me);
      if (decision.action === "local") {
        const c = this.findCircuit(pkt.tp, pkt.net.origin);
        if (c)
          c.onPacket(pkt.tp, pkt.info); // demux to the owning circuit
        else if (pkt.tp.opcode === NrOp.ConnReq && this.inboundApp) this.acceptOrReack(pkt, f.src); // L4 inbound session
      } else if (decision.action === "forward") {
        this.sendPaced(
          {
            dst: decision.neighbor,
            src: this.me,
            command: true,
            type: "UI",
            pf: false,
            pid: PID_NETROM,
            info: encodeNetrom(decision.packet),
          },
          this.isNeighbor(f.src),
        );
      } else if (decision.reason !== "no-route") {
        console.log("[netrom] dropped transit to %s (%s)", addrStr(pkt.net.dest), decision.reason);
      }
      return;
    }
    const learned = this.node.consume(f.info, f.src, this.port);
    if (learned) {
      console.log("[netrom] learned %s route(s) from %s", learned, addrStr(f.src));
      this.scheduleMirror();
    }
    this.answerNewNode(f.src);
    // A NODES broadcaster is a node on our channel — adopt it as an INP3 neighbour (measure its RTT,
    // exchange RIFs), so INP3 bootstraps off NODES discovery without any static neighbour config.
    if (this.inp3) this.ensureNeighbor(f.src);
  }

  /** Nodes whose NODES broadcast we have heard, so a newcomer is answered once. */
  private readonly heardNodes = new Set<string>();
  private lastAnswerMs = 0;

  /**
   * A node heard for the first time gets our table straight away instead of at the next interval, so two
   * nodes that came up at different times find each other without waiting minutes. It costs one broadcast
   * per new neighbour, and at most one a minute, since every broadcast keys the transmitter.
   */
  private answerNewNode(src: Ax25Address): void {
    const key = addrStr(src);
    if (this.heardNodes.has(key)) return;
    if (this.heardNodes.size >= 1000) this.heardNodes.clear();
    this.heardNodes.add(key);
    const now = Date.now();
    if (now - this.lastAnswerMs < 60_000) return;
    this.lastAnswerMs = now;
    this.broadcast();
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
        console.log("[netrom] learned %s route(s) from %s (link)", learned, addrStr(neighbor));
        this.scheduleMirror();
      }
      return;
    }
    const pkt = decodeNetrom(packet);
    if (!pkt) return;
    const decision = routeNetrom(pkt, this.node, this.me);
    if (decision.action === "local") {
      const c = this.findCircuit(pkt.tp, pkt.net.origin);
      if (c) c.onPacket(pkt.tp, pkt.info);
      else if (pkt.tp.opcode === NrOp.ConnReq && this.inboundApp) this.acceptOrReack(pkt, neighbor, reply);
    } else if (decision.action === "forward") {
      this.sendPaced(
        {
          dst: decision.neighbor,
          src: this.me,
          command: true,
          type: "UI",
          pf: false,
          pid: PID_NETROM,
          info: encodeNetrom(decision.packet),
        },
        this.isNeighbor(neighbor),
      );
    } else if (decision.reason !== "no-route") {
      console.log("[netrom] dropped link transit to %s (%s)", addrStr(pkt.net.dest), decision.reason);
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

  /** Mirror the routing table to the gateway once the changes of the next `mirrorMs` have gathered: one
   *  request per interval however many broadcasts arrive, never two at once. */
  private scheduleMirror(): void {
    if (!this.o.gatewayBase || !this.o.secret || this.mirrorTimer) return;
    this.mirrorTimer = setTimeout(() => {
      this.mirrorTimer = undefined;
      void this.mirror();
    }, this.o.mirrorMs ?? MIRROR_MS);
    this.mirrorTimer.unref?.();
  }

  /** Mirror the learned NODES routes that changed since the last mirror to the gateway node surface, in
   *  one request (best-effort; a failed request is retried at the next interval, a route the gateway refuses
   *  is logged and not resent until it changes). INP3 routes are not mirrored
   *  here (the gateway table keys on dest, which NODES already owns) — they surface in the node CLI's
   *  merged table via nodeStore(). */
  private async mirror(): Promise<void> {
    if (this.mirroring) return this.scheduleMirror();
    const table = new Map(this.node.list().map((r) => [addrStr(r.dest), r]));
    for (const k of this.mirrored.keys()) if (!table.has(k)) this.mirrored.delete(k); // re-sent if re-learned
    const changed: { dest: string; alias: string; neighbor: string; quality: number; port: string }[] = [];
    for (const [dest, r] of table) {
      const rec = {
        dest,
        alias: r.alias,
        neighbor: addrStr(r.neighbor),
        quality: r.quality,
        port: r.port ?? this.port,
      };
      if (this.mirrored.get(dest) !== JSON.stringify(rec)) changed.push(rec);
    }
    if (!changed.length) return;
    this.mirroring = true;
    const answer = await gatewayFetch(`${this.o.gatewayBase}/api/node/nodes`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ingest-secret": this.o.secret! },
      body: JSON.stringify({ nodes: changed }),
    }).then(
      async (res) =>
        res.ok ? ((await res.json().catch(() => ({}))) as { refused?: { dest?: string; error?: string }[] }) : null,
      () => null,
    );
    this.mirroring = false;
    if (!answer) return this.scheduleMirror();
    // a refused route counts as mirrored too, so it is not resent until it changes; the rest are stored
    for (const rec of changed) this.mirrored.set(rec.dest, JSON.stringify(rec));
    const refused = Array.isArray(answer.refused) ? answer.refused : [];
    if (refused.length)
      console.log(
        "[netrom] gateway refused %s route(s): %s",
        refused.length,
        refused
          .slice(0, 5)
          .map((r) => `${r.dest ?? "?"} (${r.error ?? "?"})`)
          .join(", "),
      );
  }
}

/** Present an INP3 tt (10 ms round-trip, lower = better) as a NET/ROM-style 0–255 quality for the
 *  merged node table: a direct/fast route (tt≈1) → ~250, degrading with latency. Presentation only —
 *  INP3 routing decisions stay on the native tt metric. */
function ttToQuality(tt: number): number {
  return Math.max(1, Math.min(255, Math.round(255 - Math.min(tt, 250))));
}
