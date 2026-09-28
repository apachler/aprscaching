// SPDX-License-Identifier: AGPL-3.0-or-later
import net from "node:net";
import { parseMeshtasticJson, formatPosition } from "@aprscaching/aprs";
import type { Packet } from "@aprscaching/shared";

export interface MeshOpts {
  host: string;
  port: number;
}

/**
 * Meshtastic ingest via newline-delimited JSON over TCP — point this at an MQTT→TCP bridge, e.g. a
 * `mosquitto_sub -t 'msh/+/2/json/#' -F '%p'` feed of a node's JSON MQTT output served on a TCP port
 * (e.g. behind `socat TCP-LISTEN:1884,fork`). Forwards on the `meshtastic` port.
 */
export class MeshtasticReader {
  private sock?: net.Socket;
  private buf = "";
  constructor(
    private o: MeshOpts,
    private onPacket: (p: Packet) => void,
  ) {}

  start() {
    this.connect();
  }

  private connect() {
    const s = net.connect(this.o.port, this.o.host);
    this.sock = s;
    s.setEncoding("utf8");
    s.on("connect", () => console.log(`[mesh] connected ${this.o.host}:${this.o.port}`));
    s.on("data", (chunk: string) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        const fix = parseMeshtasticJson(line);
        if (!fix) continue;
        const src = ("MSH" + fix.node.replace(/[^a-zA-Z0-9]/g, "")).slice(0, 9).toUpperCase();
        const payload = formatPosition(fix.lat, fix.lon, {
          table: "/",
          code: "p",
          altitudeM: fix.altitudeM,
          comment: fix.longName ? ` ${fix.longName}` : undefined,
        });
        this.onPacket({
          src,
          dst: "APRS",
          path: [],
          payload,
          kind: "position",
          parsed: { lat: fix.lat, lon: fix.lon } as Record<string, unknown>,
          heardVia: "aprs_is",
          port: "meshtastic",
          ts: Math.floor(Date.now() / 1000),
        });
      }
    });
    s.on("error", () => console.log("[mesh] disconnected, retrying…"));
    s.on("close", () => setTimeout(() => this.connect(), 3000));
  }
}
