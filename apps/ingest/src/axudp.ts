import dgram from "node:dgram";
import { decodeAx25 } from "@aprsweb/aprs";
import { encodeFrame, decodeFrame, type Ax25Frame } from "@aprsweb/ax25";
import type { Packet } from "@aprsweb/shared";

export interface AxudpOpts { port: number; bind?: string }
/** A UDP endpoint to send AX.25 frames to (the other end of an AXUDP link). */
export interface AxudpPeer { host: string; port: number }

/**
 * PURE: normalize one AXUDP datagram (a bare AX.25 frame over UDP) into a Tier-C ingest Packet, or null if
 * it isn't a decodable UI/APRS frame. The trust decision lives here and is deliberately fixed:
 * `heardVia: "aprs_is"` + `port: "axudp"` → the gateway's provenance derivation stamps
 * `firstPartyAttested = false`, so a tunnelled frame can NEVER reach Tier A ("transport ≠ trust", docs/22).
 * Factored out of the socket handlers so this invariant is unit-testable without a live UDP socket.
 */
export function axudpToPacket(datagram: Uint8Array, nowS = Math.floor(Date.now() / 1000)): Packet | null {
  const f = decodeAx25(datagram);
  if (!f) return null;
  return {
    src: f.src, dst: f.dst, path: f.path, payload: f.payload,
    kind: "other", heardVia: "aprs_is", port: "axudp",   // tunnelled → never first-party attested
    ts: nowS, raw: f.raw,
  };
}

/**
 * AXUDP listener — AX.25 frames tunnelled over UDP (the BPQ node mesh, port 10093). RESERVED seam
 * (docs/22): wired but feature-flagged off; start only when AXUDP_PORT is set.
 *
 * Trust note: a tunnelled frame is just a transport — it carries no proof it touched RF at a site we
 * operate. So we forward it as `heardVia: "aprs_is"` on the `axudp` port; the gateway's provenance
 * derivation (provenance.ts) therefore stamps firstPartyAttested = false and it can NEVER reach
 * Tier A. "Transport convenience is not trust uplift."
 */
export class AxudpListener {
  private sock?: dgram.Socket;
  constructor(private o: AxudpOpts, private onPacket: (p: Packet) => void) {}

  start() {
    const s = dgram.createSocket("udp4");
    this.sock = s;
    s.on("message", (msg: Buffer) => {
      const p = axudpToPacket(Uint8Array.from(msg));
      if (p) this.onPacket(p);
    });
    s.on("error", (e) => console.error("[axudp] socket error:", e.message));
    s.bind(this.o.port, this.o.bind);
    console.log(`[axudp] listening udp/${this.o.port} (tunnelled AX.25 — Tier C only)`);
  }
}

/**
 * AXUDP as a bidirectional KISS-equivalent PORT (docs/29 F5): the same raw AX.25 frames a KISS TNC
 * carries, but over UDP, so NET/ROM crosslinks *and* FBB forwarding run over the Internet leg of the
 * bridge. `send()` datagrams a full frame to each configured peer; `onRaw`/`onFrame` deliver inbound
 * frames to the connected-mode consumers (the same interface shape as KissTnc). The Tier-C ingest path
 * is preserved via `onPacket` — a tunnelled frame is still never first-party-attested (see above).
 */
export class AxudpPort {
  private sock?: dgram.Socket;
  private rawCbs: ((b: Uint8Array) => void)[] = [];
  private frameCbs: ((f: Ax25Frame) => void)[] = [];
  constructor(private o: AxudpOpts & { peers: AxudpPeer[] }, private onPacket?: (p: Packet) => void) {}

  start() {
    const s = dgram.createSocket("udp4");
    this.sock = s;
    s.on("message", (msg: Buffer) => {
      const bytes = Uint8Array.from(msg);
      for (const cb of this.rawCbs) cb(bytes);
      const f = decodeFrame(bytes);
      if (f) for (const cb of this.frameCbs) cb(f);
      const p = axudpToPacket(bytes);                     // also feed the Tier-C ingest (positions/etc.)
      if (p && this.onPacket) this.onPacket(p);
    });
    s.on("error", (e) => console.error("[axudp] socket error:", e.message));
    s.bind(this.o.port, this.o.bind);
    console.log(`[axudp] port udp/${this.o.port} ↔ ${this.o.peers.map((p) => `${p.host}:${p.port}`).join(", ") || "(no peers)"} (Tier C)`);
  }

  /** Send a full AX.25 frame to every configured peer (best-effort). */
  sendFrame(f: Ax25Frame): boolean {
    if (!this.sock) return false;
    const bytes = encodeFrame(f);
    let ok = false;
    for (const p of this.o.peers) { try { this.sock.send(bytes, p.port, p.host); ok = true; } catch { /* drop */ } }
    return ok;
  }

  onRaw(cb: (b: Uint8Array) => void): void { this.rawCbs.push(cb); }
  onFrame(cb: (f: Ax25Frame) => void): void { this.frameCbs.push(cb); }
}

/** Parse "host:port,host:port" into peer endpoints (AXUDP default port 10093). */
export function parseAxudpPeers(spec: string): AxudpPeer[] {
  return spec.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const [host, port] = s.split(":");
    return { host: host!, port: Number(port) || 10093 };
  });
}
