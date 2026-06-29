import dgram from "node:dgram";
import { decodeAx25 } from "@aprsweb/aprs";
import type { Packet } from "@aprsweb/shared";

export interface AxudpOpts { port: number; bind?: string }

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
      const f = decodeAx25(Uint8Array.from(msg));
      if (!f) return;
      this.onPacket({
        src: f.src, dst: f.dst, path: f.path, payload: f.payload,
        kind: "other", heardVia: "aprs_is", port: "axudp",  // tunnelled → never first-party attested
        ts: Math.floor(Date.now() / 1000), raw: f.raw,
      });
    });
    s.on("error", (e) => console.error("[axudp] socket error:", e.message));
    s.bind(this.o.port, this.o.bind);
    console.log(`[axudp] listening udp/${this.o.port} (tunnelled AX.25 — Tier C only)`);
  }
}
