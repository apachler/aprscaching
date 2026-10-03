// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * MeshCom ExtUDP listener — the operator-local socket in front of the pure core in @aprscaching/aprs.
 *
 * A MeshCom node streams the frames it handles to one host on its LAN (UDP 1799, JSON). This listener
 * accepts datagrams only from configured node addresses, bounds their size and rate, forwards one copy
 * per frame (a stronger RF copy of an already-forwarded frame goes out again as an upgrade), and stamps
 * each packet with the transport hint that feeds the gateway's provenance derivation: only a direct LoRa
 * hearing names the receiving node as its gate, and the gateway lifts that toward Tier A only when the
 * node's call is an attested site. It never transmits; the sender is separate and off by default.
 *
 * Node and Bun only — the Workers build never includes this file (tools/checks/worker-bundle.mjs).
 */
import dgram from "node:dgram";
import { networkInterfaces } from "node:os";
import {
  decodeMeshcom,
  meshcomToAprs,
  meshcomTransportHint,
  MeshcomDedup,
  MESHCOM_MAX_DATAGRAM,
  type MeshcomEvent,
  type MeshcomMsgEvent,
} from "@aprscaching/aprs";
import { sanitizeMeshcomMeta, type MeshcomMeta, type Packet } from "@aprscaching/shared";

/** The node's fixed ExtUDP port (`EXTERN_PORT` in the firmware). */
export const MESHCOM_PORT = 1799;

export interface MeshcomNode {
  ip: string;
  /** The node's own callsign: names it as the gate of direct hearings and marks its own frames. */
  call?: string;
}

export interface MeshcomOpts {
  nodes: MeshcomNode[];
  port?: number;
  /** Local address to bind; defaults to this host's address on the first node's subnet. */
  bind?: string;
  /** Local tools that also want the raw datagrams (the port can have only one owner). */
  fanout?: { host: string; port: number }[];
  /** Per-node datagram rate: sustained per second, and burst. */
  ratePerSec?: number;
  rateBurst?: number;
  /** Warn when no datagram arrived for this long. */
  staleMs?: number;
  /** Interval of the counters log line. */
  statsMs?: number;
}

/** `192.168.1.50=OE8APR-12, 192.168.1.51` → node list. */
export function parseMeshcomNodes(spec: string): MeshcomNode[] {
  return spec
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((entry) => {
      const [ip, call] = entry.split("=");
      return { ip: ip!.trim(), ...(call?.trim() ? { call: call.trim().toUpperCase() } : {}) };
    });
}

/** `127.0.0.1:1800, 127.0.0.1:1801` → fan-out targets; a malformed target is skipped with a warning. */
export function parseMeshcomFanout(spec: string | undefined): { host: string; port: number }[] {
  const out: { host: string; port: number }[] = [];
  for (const t of (spec ?? "").split(/[,\s]+/).filter(Boolean)) {
    const i = t.lastIndexOf(":");
    const port = Number(t.slice(i + 1));
    if (i <= 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
      console.warn(`[meshcom] ignoring MESHCOM_FANOUT target "${t}" — expected host:port`);
      continue;
    }
    out.push({ host: t.slice(0, i), port });
  }
  return out;
}

const ipv4 = (ip: string) => ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;

/** This host's IPv4 address on the subnet that contains `nodeIp`, or null. */
export function lanAddressFor(nodeIp: string, ifaces = networkInterfaces()): string | null {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(nodeIp)) return null;
  const target = ipv4(nodeIp);
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const mask = ipv4(a.netmask);
      if ((ipv4(a.address) & mask) === (target & mask)) return a.address;
    }
  }
  return null;
}

/** MeshCom firmware at or before this build crashes an ESP32 node with ExtUDP on (fixed 2026-09-25). */
function firmwareRisk(fw: string): "affected" | "unknown-build" | null {
  const m = /^(\d+)\.(\d+)([a-z]?)$/.exec(fw);
  if (!m) return null;
  const [maj, min, sub] = [Number(m[1]), Number(m[2]), m[3] ?? ""];
  const v = maj * 1000 + min;
  if (v < 4035 || (v === 4035 && sub < "t")) return "affected";
  if (v === 4035 && sub === "t") return "unknown-build";
  return null;
}

export type MeshcomCounters = {
  received: number;
  forwarded: number;
  deduped: number;
  upgraded: number;
  rf: number;
  udp: number;
  own: number;
  tele: number;
  /** Delivery acks the node reported for its own direct messages; counted, not forwarded. */
  acks: number;
  /** Via-path tokens dropped from messages because they are not callsigns; the messages themselves are kept. */
  viaDropped: number;
  rejected: Record<string, number>;
};

/**
 * What the node told us about a frame beyond its APRS form, for the map: how it was heard, the signal of a
 * LoRa hearing, the sender's device. Display only; the gateway sanitises it again and never trusts it.
 */
export function meshcomMetaOf(e: MeshcomEvent, receiverCall: string | undefined): MeshcomMeta | null {
  const p = e.provenance;
  return sanitizeMeshcomMeta({
    srcType: p.srcType,
    direct: p.direct,
    path: p.path,
    receiver: receiverCall?.toUpperCase(),
    // a signal report counts only for a real LoRa hearing, never the node's own frames
    ...(p.rf ? { rssi: p.rssi, snr: p.snr } : {}),
    firmware: p.firmware,
    ...(e.type === "pos" ? { hwId: e.hwId, batt: e.batt } : {}),
    ...(e.type === "msg" && e.hwId !== undefined ? { hwId: e.hwId } : {}),
    // a message carries its sender's via list, empty when it named none (display only)
    ...(e.type === "msg" ? { via: e.via ?? [] } : {}),
  });
}

export function meshcomToPacket(e: MeshcomEvent, receiverCall: string | undefined, ts: number): Packet | null {
  const f = meshcomToAprs(e);
  if (!f) return null;
  const hint = meshcomTransportHint(e.provenance, receiverCall);
  const meta = meshcomMetaOf(e, receiverCall);
  const parsed: Record<string, unknown> = {
    ...(f.lat !== undefined ? { lat: f.lat, lon: f.lon } : {}),
    ...(meta ? { meshcom: meta } : {}),
  };
  return {
    src: f.src,
    dst: "APRS",
    path: f.path,
    payload: f.payload,
    kind: f.kind,
    ...(Object.keys(parsed).length ? { parsed } : {}),
    heardVia: hint.heardVia,
    ...(hint.igateCall ? { igateCall: hint.igateCall } : {}),
    port: "meshcom",
    // the node that heard it — where an answer to the sender is sent from (routing, not trust)
    ...(receiverCall ? { rxCall: receiverCall.toUpperCase() } : {}),
    ts,
  };
}

interface Bucket {
  tokens: number;
  at: number;
}

export class MeshcomListener {
  private sock?: dgram.Socket;
  private fanSock?: dgram.Socket;
  private timer?: ReturnType<typeof setInterval>;
  private readonly nodes: Map<string, MeshcomNode>;
  private readonly receiverCalls: string[];
  private readonly dedup = new MeshcomDedup();
  private readonly buckets = new Map<string, Bucket>();
  private readonly fwWarned = new Set<string>();
  /** The via list each own node's latest message named ("" for none), to log its Via setting once per change. */
  private readonly ownVia = new Map<string, string>();
  private lastSeen = 0;
  private startedAt = Date.now();
  private staleWarned = false;
  readonly counters: MeshcomCounters = {
    received: 0,
    forwarded: 0,
    deduped: 0,
    upgraded: 0,
    rf: 0,
    udp: 0,
    own: 0,
    tele: 0,
    acks: 0,
    viaDropped: 0,
    rejected: {},
  };

  constructor(
    private o: MeshcomOpts,
    private onPacket: (p: Packet) => void,
    private log: Pick<Console, "log" | "warn" | "error"> = console,
  ) {
    this.nodes = new Map(o.nodes.map((n) => [n.ip, n]));
    this.receiverCalls = o.nodes.flatMap((n) => (n.call ? [n.call] : []));
  }

  private reject(reason: string): null {
    this.counters.rejected[reason] = (this.counters.rejected[reason] ?? 0) + 1;
    return null;
  }

  private allow(ip: string, now: number): boolean {
    const rate = this.o.ratePerSec ?? 20,
      burst = this.o.rateBurst ?? 60;
    const b = this.buckets.get(ip) ?? { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * rate);
    b.at = now;
    this.buckets.set(ip, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Handle one datagram; the socket calls this, and tests call it directly. */
  receive(msg: Uint8Array, from: string, now = Date.now()): Packet | null {
    this.counters.received++;
    const node = this.nodes.get(from);
    if (!node) return this.reject("not-allowlisted");
    if (msg.byteLength > MESHCOM_MAX_DATAGRAM) return this.reject("too-large");
    if (!this.allow(from, now)) return this.reject("rate-limited");
    this.lastSeen = now;
    this.staleWarned = false;
    this.fanOut(msg);

    const d = decodeMeshcom(msg, { receiverCalls: this.receiverCalls });
    if (!d.ok && d.reason === "ack") {
      this.counters.acks++;
      return null;
    }
    if (!d.ok) return this.reject(d.reason);
    const e = d.event;
    this.checkFirmware(e, node);
    if (e.type === "msg" && e.viaDropped) this.counters.viaDropped += e.viaDropped;
    if (e.type === "msg") this.checkOwnVia(e);
    if (e.type === "tele") {
      this.counters.tele++;
      return null;
    }

    const verdict = this.dedup.offer(e, now);
    if (verdict === "duplicate") {
      this.counters.deduped++;
      return null;
    }
    if (verdict === "upgrade") this.counters.upgraded++;
    if (e.provenance.rf) this.counters.rf++;
    else if (e.provenance.srcType === "udp") this.counters.udp++;
    else this.counters.own++;

    const p = meshcomToPacket(e, node.call, Math.floor(now / 1000));
    if (!p) return null;
    this.counters.forwarded++;
    this.onPacket(p);
    return p;
  }

  /** Warn once per node when its own frames report firmware with the ExtUDP crash. */
  /**
   * The node echoes the messages it sends with its own `--via` list in the destination path. With Via on, the
   * node forwards everything sent through it — replies, find confirmations — only through those relays, so
   * the operator hears about it once per change. Only the node's own echoes count, and nothing here ever
   * changes the node's setting.
   */
  private checkOwnVia(e: MeshcomMsgEvent) {
    if (e.provenance.srcType !== "node") return; // "node" frames are the node's own traffic
    const relays = (e.via ?? []).join(",");
    if (this.ownVia.get(e.src) === relays) return;
    this.ownVia.set(e.src, relays);
    if (relays)
      this.log.warn(
        `[meshcom] node ${e.src} has Via on: messages sent through it, replies included, are forwarded only by ${relays.replaceAll(",", ", ")}`,
      );
    else this.log.log(`[meshcom] node ${e.src} has Via off`);
  }

  private checkFirmware(e: MeshcomEvent, node: MeshcomNode) {
    if (e.provenance.srcType !== "node" || !e.provenance.firmware || this.fwWarned.has(node.ip)) return;
    const risk = firmwareRisk(e.provenance.firmware);
    this.fwWarned.add(node.ip);
    if (risk === "affected")
      this.log.warn(
        `[meshcom] node ${node.ip} runs firmware ${e.provenance.firmware}, which can crash an ESP32 node with --extudp on — update to a 4.35t build from 2026-09-25 or later`,
      );
    else if (risk === "unknown-build")
      this.log.warn(
        `[meshcom] node ${node.ip} runs firmware 4.35t; builds before 2026-09-25 can crash an ESP32 node with --extudp on — update if the node restarts`,
      );
  }

  private fanOut(msg: Uint8Array) {
    if (!this.fanSock || !this.o.fanout?.length) return;
    for (const t of this.o.fanout) this.fanSock.send(msg, t.port, t.host);
  }

  /** One structured counters line; message payloads are never logged. */
  stats(now = Date.now()) {
    return {
      ...this.counters,
      rejected: { ...this.counters.rejected },
      lastSeenAgoS: this.lastSeen ? Math.round((now - this.lastSeen) / 1000) : null,
    };
  }

  /** Warn once when the node has gone quiet; resets on the next datagram. */
  checkStale(now = Date.now()): boolean {
    const staleMs = this.o.staleMs ?? 30 * 60_000;
    const since = this.lastSeen || this.startedAt;
    if (now - since < staleMs || this.staleWarned) return false;
    this.staleWarned = true;
    this.log.warn(
      `[meshcom] no datagram from ${[...this.nodes.keys()].join(", ")} for ${Math.round((now - since) / 60_000)} min — check the node's Wi-Fi and --extudpip`,
    );
    return true;
  }

  start() {
    const port = this.o.port ?? MESHCOM_PORT;
    const first = this.o.nodes[0]?.ip;
    const bind = this.o.bind ?? (first ? lanAddressFor(first) : null);
    if (!bind) {
      this.log.error(
        `[meshcom] no local address on the subnet of ${first ?? "(no node)"} — set MESHCOM_BIND to this host's LAN address`,
      );
      return;
    }
    if (bind === "0.0.0.0")
      this.log.warn(
        "[meshcom] bound to all interfaces — the ExtUDP interface is unauthenticated: on a host reachable from the internet bind the LAN address instead; in a container publish 1799/udp on the host's LAN address only",
      );

    const s = dgram.createSocket("udp4");
    this.sock = s;
    s.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
      this.receive(msg, rinfo.address);
    });
    s.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE") {
        this.log.error(
          `[meshcom] udp/${port} on ${bind} is already in use — another MeshCom client owns it (MeshcomWebDesk, gomeshcomd, Home Assistant, MCProxy?). Stop it, or let this listener own the port and pass datagrams on with MESHCOM_FANOUT. MeshCom ingest is disabled.`,
        );
      } else {
        this.log.error(`[meshcom] socket error: ${e.message} — MeshCom ingest is disabled`);
      }
      this.stop();
    });
    s.bind(port, bind, () => {
      this.startedAt = Date.now();
      this.log.log(
        `[meshcom] listening udp/${port} on ${bind} for ${this.o.nodes.map((n) => (n.call ? `${n.ip} (${n.call})` : n.ip)).join(", ")}`,
      );
    });
    if (this.o.fanout?.length) this.fanSock = dgram.createSocket("udp4");

    const statsMs = this.o.statsMs ?? 10 * 60_000;
    this.timer = setInterval(() => {
      this.log.log(`[meshcom] stats ${JSON.stringify(this.stats())}`);
      this.checkStale();
    }, statsMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const sock of [this.sock, this.fanSock]) {
      try {
        sock?.close();
      } catch {
        // already closed
      }
    }
    this.sock = undefined;
    this.fanSock = undefined;
  }

  /** The bound socket (for tests). */
  get socket(): dgram.Socket | undefined {
    return this.sock;
  }
}
