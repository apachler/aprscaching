// SPDX-License-Identifier: AGPL-3.0-or-later
import dgram from "node:dgram";
import { parseCot, splitCotEvents, formatPosition } from "@aprsweb/aprs";
import type { Packet } from "@aprsweb/shared";

export interface CotOpts {
  port: number;
  bind?: string;
}

/**
 * TAK/CoT inbound listener (UDP, default :6969). Each <event> is parsed to a fix, normalised to an
 * APRS position payload, and forwarded on the `tak` port so it flows through the same decoder.
 */
export class CotListener {
  private sock?: dgram.Socket;
  constructor(
    private o: CotOpts,
    private onPacket: (p: Packet) => void,
  ) {}

  start() {
    const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.sock = s;
    s.on("message", (msg) => {
      for (const ev of splitCotEvents(msg.toString("utf8"))) {
        const fix = parseCot(ev);
        if (!fix) continue;
        const src =
          fix.callsign
            .replace(/[^A-Z0-9-]/gi, "")
            .slice(0, 9)
            .toUpperCase() || "COT";
        const payload = formatPosition(fix.lat, fix.lon, {
          course: fix.course,
          speedKn: fix.speedKn,
          altitudeM: fix.altitudeM,
          comment: fix.comment ? ` ${fix.comment}` : undefined,
        });
        this.onPacket({
          src,
          dst: "APRS",
          path: [],
          payload,
          kind: "position",
          parsed: { lat: fix.lat, lon: fix.lon } as Record<string, unknown>,
          heardVia: "aprs_is",
          port: "tak",
          ts: Math.floor(Date.now() / 1000),
        });
      }
    });
    s.on("error", (e) => console.error("[cot]", e.message));
    s.bind(this.o.port, this.o.bind ?? "0.0.0.0", () => console.log(`[cot] listening udp/${this.o.port}`));
  }
}
