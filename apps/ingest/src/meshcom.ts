// SPDX-License-Identifier: AGPL-3.0-or-later
import dgram from "node:dgram";
import { decodeMeshcom, meshcomToAprs, MESHCOM_MAX_DATAGRAM } from "@aprscaching/aprs";
import type { Packet } from "@aprscaching/shared";

export interface MeshcomOpts {
  /** The MeshCom node's IP. Datagrams from any other address are dropped. */
  node: string;
  port: number;
  bind?: string;
}

/**
 * Normalise one external-UDP datagram into a Packet on the `meshcom` port.
 *
 * Every MeshCom frame is Tier C: the external interface is unauthenticated and a `udp`-sourced frame
 * crossed the internet via the MeshCom server. So the packet is forwarded as `heardVia: "aprs_is"`
 * with no IGate — the gateway's provenance derivation then yields `firstPartyAttested = false`.
 * Emitting `rf` here would let an attested-IGate path lift a mesh frame toward Tier A.
 */
export function meshcomToPacket(datagram: string | Uint8Array, ts = Math.floor(Date.now() / 1000)): Packet | null {
  const d = decodeMeshcom(datagram);
  const f = d.ok ? meshcomToAprs(d.event) : null;
  if (!f) return null;
  return {
    src: f.src,
    dst: "APRS",
    path: f.path,
    payload: f.payload,
    kind: f.kind,
    ...(f.lat !== undefined ? { parsed: { lat: f.lat, lon: f.lon } as Record<string, unknown> } : {}),
    heardVia: "aprs_is",
    port: "meshcom",
    ts,
  };
}

/** How long one MeshCom frame id counts as already forwarded. */
const DEDUPE_MS = 10 * 60_000;
const DEDUPE_MAX = 4096;

/**
 * RX-only listener for a MeshCom node's external UDP interface (default :1799). A node hears the
 * same frame over LoRa and again from the MeshCom server, so copies sharing a frame id are
 * forwarded once. It never transmits.
 */
export class MeshcomListener {
  private sock?: dgram.Socket;
  private seen = new Map<string, number>();
  constructor(
    private o: MeshcomOpts,
    private onPacket: (p: Packet) => void,
  ) {}

  /** Handle one datagram; exposed so the source-pin and dedupe rules are testable without a socket. */
  receive(msg: Uint8Array, from: string, now = Date.now()): Packet | null {
    if (from !== this.o.node) return null;
    if (msg.length > MESHCOM_MAX_DATAGRAM) return null;
    const d = decodeMeshcom(msg);
    if (!d.ok) return null;
    const f = { kind: d.event.type, src: d.event.src, msgId: d.event.provenance.msgId };
    if (f.msgId) {
      const key = `${f.kind}:${f.src}:${f.msgId}`;
      const at = this.seen.get(key);
      if (at !== undefined && now - at < DEDUPE_MS) return null;
      this.remember(key, now);
    }
    const p = meshcomToPacket(msg, Math.floor(now / 1000));
    if (p) this.onPacket(p);
    return p;
  }

  private remember(key: string, now: number) {
    this.seen.delete(key); // re-insert so Map order stays oldest-first
    this.seen.set(key, now);
    if (this.seen.size <= DEDUPE_MAX) return;
    for (const [k, at] of this.seen) {
      if (this.seen.size <= DEDUPE_MAX && now - at < DEDUPE_MS) break;
      this.seen.delete(k);
    }
  }

  start() {
    const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.sock = s;
    s.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
      this.receive(Uint8Array.from(msg), rinfo.address);
    });
    // A bind failure (port busy) must not kill the listener permanently: retry once the address frees.
    s.on("error", (e: NodeJS.ErrnoException) => {
      console.error("[meshcom]", e.message);
      if (e.code === "EADDRINUSE") {
        setTimeout(() => {
          try {
            s.bind(this.o.port, this.o.bind ?? "0.0.0.0");
          } catch (err) {
            console.error("[meshcom] rebind failed:", (err as Error).message);
          }
        }, 5000).unref?.();
      }
    });
    s.bind(this.o.port, this.o.bind ?? "0.0.0.0", () =>
      console.log(`[meshcom] listening udp/${this.o.port} for node ${this.o.node} (RX-only, Tier C)`),
    );
  }

  stop(): void {
    this.sock?.close();
    this.sock = undefined;
  }
}
