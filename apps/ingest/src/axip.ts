// SPDX-License-Identifier: AGPL-3.0-or-later
import { decodeAx25 } from "@aprscaching/aprs";
import { encodeFrame, decodeFrame, appendAxipCrc, stripAxipCrc, type Ax25Frame } from "@aprscaching/ax25";
import type { Packet } from "@aprscaching/shared";
import { PeerAllowlist, openListenerWarning, type Resolver } from "./peerfilter.js";

/**
 * axip.ts — AXIP listener: AX.25 frames encapsulated directly in **IP protocol 93** (the JNOS/BPQ AXIP
 * mode), as opposed to AXUDP (axudp.ts), which wraps the same frames in UDP port 10093. RESERVED seam
 *: wired but feature-flagged off; start only when AXIP_ENABLE is set.
 *
 * The one thing genuinely different from AXUDP: a raw proto-93 socket delivers the **whole IP datagram
 * including the IP header** (a UDP socket hands you just the payload), so we strip the IPv4 header before
 * decoding the AX.25 frame. The rest is identical — and identically trust-neutral: a tunnelled frame is
 * `heardVia: "aprs_is"` on the `axip` port, so the gateway's provenance derivation stamps
 * `firstPartyAttested = false` and it can NEVER reach Tier A. "Transport convenience is not trust uplift."
 *
 * Node has no built-in raw-IP socket, so the actual capture uses the optional `raw-socket` native package
 * (loaded dynamically; absent → the listener logs and stays inert). The decode/normalize below is pure and
 * unit-tested; only the raw-socket bind is validate-at-deploy (and needs CAP_NET_RAW / root).
 */

/** Strip an IPv4 header, returning the payload (the AX.25 frame), or null if it isn't a v4 datagram. */
export function stripIpv4Header(datagram: Uint8Array): Uint8Array | null {
  if (datagram.length < 20) return null; // minimum IPv4 header
  if (datagram[0]! >> 4 !== 4) return null; // version must be 4
  const ihl = (datagram[0]! & 0x0f) * 4; // header length (32-bit words → bytes)
  if (ihl < 20 || ihl > datagram.length) return null;
  return datagram.subarray(ihl);
}

/** PURE: the source address of a raw IPv4 datagram (its header's bytes 12–15), or null without a header. */
export function ipv4Source(datagram: Uint8Array): string | null {
  if (!stripIpv4Header(datagram)) return null;
  return `${datagram[12]}.${datagram[13]}.${datagram[14]}.${datagram[15]}`;
}

/** PURE: the destination address of a raw IPv4 datagram (its header's bytes 16–19), or null without a header. */
export function ipv4Dest(datagram: Uint8Array): string | null {
  if (!stripIpv4Header(datagram)) return null;
  return `${datagram[16]}.${datagram[17]}.${datagram[18]}.${datagram[19]}`;
}

/**
 * PURE: whether a datagram reached the local address AXIP_BIND names. A raw socket receives proto-93 traffic
 * for every address of the host, so the bind is applied to the destination in each datagram's IPv4 header.
 * No bind (or the wildcard `0.0.0.0`) accepts every address; a datagram without an IPv4 header carries no
 * destination to check and is refused under a bind.
 */
export function axipBindAccepts(bind: string | undefined, datagram: Uint8Array): boolean {
  const b = bind?.trim();
  if (!b || b === "0.0.0.0") return true;
  return ipv4Dest(datagram) === b;
}

/**
 * PURE: normalize one AXIP datagram into a Tier-C ingest Packet, or null. Prefers stripping the IPv4 header
 * (raw proto-93 sockets include it); falls back to treating the datagram as a bare AX.25 frame for stacks
 * that hand over the payload only. The Tier-C mapping (`heardVia:"aprs_is"`, `port:"axip"`) is fixed here so
 * a tunnelled frame can never be first-party attested, exactly like the AXUDP path.
 */
export function axipToPacket(datagram: Uint8Array, nowS = Math.floor(Date.now() / 1000)): Packet | null {
  const stripped = stripIpv4Header(datagram);
  const f = (stripped && decodeAx25(stripAxipCrc(stripped))) || decodeAx25(stripAxipCrc(datagram));
  if (!f) return null;
  return {
    src: f.src,
    dst: f.dst,
    path: f.path,
    payload: f.payload,
    kind: "other",
    heardVia: "aprs_is",
    port: "axip", // tunnelled → never first-party attested
    ts: nowS,
    raw: f.raw,
  };
}

/**
 * PURE: encode an AX.25 frame into the AXIP wire payload for TX. AXIP egress does NOT prepend an IP header
 * — a raw proto-93 socket lets the kernel build it (it only writes the payload) — so the AXIP payload is
 * the AX.25 frame plus the RFC 1226 CRC trailer, identical to `frameToAxudp`. Symmetric with
 * `axipToPacket`'s decode.
 */
export function frameToAxip(f: Ax25Frame): Uint8Array {
  return appendAxipCrc(encodeFrame(f));
}

const AX25_PROTO = 93; // IANA IP protocol number for AX.25
export interface AxipOpts {
  /** Local IPv4 address (AXIP_BIND): only datagrams addressed to it are taken. */
  bind?: string;
}
/** An AXIP peer is just an IP host (no port — AXIP rides IP proto 93 directly, not UDP). */
export interface AxipPeer {
  host: string;
}

/** The tiny slice of the optional `raw-socket` API we use (kept local so the dep stays out of the build). */
interface RawSocket {
  on(ev: string, cb: (arg: unknown) => void): void;
  send(buf: Buffer, off: number, len: number, addr: string, cb?: (err: unknown) => void): void;
  close?(): void;
}
interface RawSocketModule {
  createSocket(opts: { protocol: number }): RawSocket;
}

async function openRawSocket(): Promise<RawSocket | null> {
  const pkg = "raw-socket"; // dynamic + non-literal so tsc doesn't require the dep
  try {
    return ((await import(pkg)) as RawSocketModule).createSocket({ protocol: AX25_PROTO });
  } catch {
    console.warn(
      "[axip] optional 'raw-socket' package not installed — AXIP disabled (npm i raw-socket, needs CAP_NET_RAW)",
    );
    return null;
  }
}

/** RX-only AXIP listener over a raw IP proto-93 socket (opt-in; tunnelled frames stay Tier C). */
export class AxipListener {
  private sock?: RawSocket;
  constructor(
    private o: AxipOpts,
    private onPacket: (p: Packet) => void,
  ) {}

  async start(): Promise<void> {
    const s = await openRawSocket();
    if (!s) return;
    console.warn(openListenerWarning("axip", "AXIP_BIND", "AXIP_PEERS"));
    this.sock = s;
    s.on("message", (buf: unknown) => {
      const bytes = Uint8Array.from(buf as Buffer);
      if (!axipBindAccepts(this.o.bind, bytes)) return;
      const p = axipToPacket(bytes);
      if (p) this.onPacket(p);
    });
    s.on("error", (e: unknown) => console.error("[axip] socket error:", (e as Error).message));
    console.log(
      `[axip] listening IP proto/${AX25_PROTO}${this.o.bind ? ` on ${this.o.bind}` : ""} (tunnelled AX.25 — Tier C only)`,
    );
  }
}

/**
 * Bidirectional AXIP PORT (RX + TX) — the raw-IP twin of `AxudpPort`. Inbound frames
 * feed the Tier-C ingest AND the connected-mode consumers (`onRaw`/`onFrame`), so NET/ROM crosslinks + FBB
 * forwarding can run over the AXIP internet leg; `sendFrame` egresses a full AX.25 frame to each configured
 * peer. TX here is **operator-config-gated** (the sysop sets `AXIP_PEERS`) internet node-transport, NOT
 * on-air keying — the callsign control-verification RF-TX gate is a separate concern (the box tx path). Tunnelled
 * frames are never first-party attested either way (transport ≠ trust). Raw-socket send is validate-at-deploy.
 */
export class AxipPort {
  private sock?: RawSocket;
  private rawCbs: ((b: Uint8Array) => void)[] = [];
  private frameCbs: ((f: Ax25Frame) => void)[] = [];
  /** Only the configured peers' addresses may feed the node, BBS and ingest. */
  readonly allowlist: PeerAllowlist;
  constructor(
    private o: AxipOpts & { peers: AxipPeer[]; resolve?: Resolver; refreshMs?: number },
    private onPacket?: (p: Packet) => void,
  ) {
    this.allowlist = new PeerAllowlist({
      name: "axip",
      hosts: o.peers.map((p) => p.host),
      resolve: o.resolve,
      refreshMs: o.refreshMs,
    });
  }

  /** Datagrams refused because they came from a host that is not a configured peer. */
  get dropped(): number {
    return this.allowlist.dropped;
  }

  /**
   * Handle one received raw datagram. The sender is read from the IPv4 header (raw proto-93 sockets
   * include it), else from the address the socket reports.
   */
  receive(bytes: Uint8Array, source?: string): void {
    if (!axipBindAccepts(this.o.bind, bytes)) return;
    if (!this.allowlist.allows(ipv4Source(bytes) ?? source)) return;
    const body = stripAxipCrc(stripIpv4Header(bytes) ?? bytes); // connected-mode consumers want the bare frame
    for (const cb of this.rawCbs) cb(body);
    const f = decodeFrame(body);
    if (f) for (const cb of this.frameCbs) cb(f);
    const p = axipToPacket(bytes);
    if (p && this.onPacket) this.onPacket(p);
  }

  async start(): Promise<void> {
    const s = await openRawSocket();
    if (!s) return;
    await this.allowlist.start();
    this.sock = s;
    s.on("message", (buf: unknown, source?: unknown) => {
      this.receive(Uint8Array.from(buf as Buffer), typeof source === "string" ? source : undefined);
    });
    s.on("error", (e: unknown) => console.error("[axip] socket error:", (e as Error).message));
    console.log(
      `[axip] port IP proto/${AX25_PROTO}${this.o.bind ? ` on ${this.o.bind}` : ""} ↔ ${this.o.peers.map((p) => p.host).join(", ") || "(no peers)"} (Tier C)`,
    );
  }

  /** Send a full AX.25 frame to every configured peer (best-effort). The kernel adds the IP header. */
  sendFrame(f: Ax25Frame): boolean {
    if (!this.sock) return false;
    const bytes = Buffer.from(frameToAxip(f));
    let ok = false;
    for (const p of this.o.peers) {
      try {
        this.sock.send(bytes, 0, bytes.length, p.host);
        ok = true;
      } catch {
        /* drop */
      }
    }
    return ok;
  }

  onRaw(cb: (b: Uint8Array) => void): void {
    this.rawCbs.push(cb);
  }
  onFrame(cb: (f: Ax25Frame) => void): void {
    this.frameCbs.push(cb);
  }
}

/** Parse "host,host" into AXIP peers (no port — AXIP is IP-proto-93, not UDP). */
export function parseAxipPeers(spec: string): AxipPeer[] {
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((host) => ({ host }));
}
