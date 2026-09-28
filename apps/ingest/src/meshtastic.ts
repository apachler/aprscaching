// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * meshtastic.ts — Meshtastic ingest at the box, from either protobuf feed:
 *
 *  - the node's TCP API (`MESHTASTIC_HOST`, port 4403): the same `0x94 0xC3`-framed FromRadio stream a
 *    node sends over USB serial, started with the same `want_config` handshake the browser path uses;
 *  - an MQTT broker (`MESHTASTIC_MQTT_URL`): the protobuf ServiceEnvelopes nodes uplink (`msh/…/2/e/…`).
 *
 * Only licensed nodes enter the map: a node's NodeInfo must carry Meshtastic's licensed flag and a
 * callsign long name, and its positions are forwarded under that callsign. Anything else — a licence-free
 * node, or one whose NodeInfo has not arrived yet — is dropped. Every packet is `heardVia: "aprs_is"` on
 * the `meshtastic` port: a Meshtastic hearing is never attestable RF evidence.
 */
import net from "node:net";
import {
  deframeMeshtastic,
  parseFromRadio,
  parseMeshServiceEnvelope,
  wantConfigFrame,
  formatPosition,
  MeshtasticLicensedNodes,
  type MeshEvent,
} from "@aprscaching/aprs";
import type { Packet } from "@aprscaching/shared";
import { Backoff } from "./backoff.js";
import { MqttSubscriber } from "./mqtt.js";

/** A stream that never completes a frame within this many bytes is not a Meshtastic stream: drop it. */
export const MESHTASTIC_RX_MAX_BYTES = 64 * 1024;

/** Turns decoded Meshtastic events into ingest packets for licensed nodes only. Shared by both feeds. */
export class MeshtasticIngest {
  readonly licensed = new MeshtasticLicensedNodes();
  /** Positions dropped because their node is not known to be licensed. */
  dropped = 0;
  private warned = false;

  constructor(
    private onPacket: (p: Packet) => void,
    private log: (m: string) => void = (m) => console.log(m),
  ) {}

  handle(ev: MeshEvent | null, now = Date.now()): void {
    this.licensed.observe(ev, now);
    if (ev?.kind !== "position") return;
    const call = this.licensed.callsignFor(ev.fix.node, now);
    if (!call) {
      this.dropped++;
      if (!this.warned) {
        this.warned = true;
        this.log(
          "[meshtastic] dropping positions from nodes not known to be licensed — only nodes in licensed (ham) mode with a callsign long name are accepted, once their NodeInfo has been heard",
        );
      }
      return;
    }
    const { fix } = ev;
    this.onPacket({
      src: call,
      dst: "APRS",
      path: [],
      payload: formatPosition(fix.lat, fix.lon, { table: "/", code: "p", altitudeM: fix.altitudeM }),
      kind: "position",
      parsed: { lat: fix.lat, lon: fix.lon } as Record<string, unknown>,
      heardVia: "aprs_is",
      port: "meshtastic",
      ts: Math.floor(now / 1000),
    });
  }
}

/** The node's protobuf TCP API (port 4403) — the serial stream over TCP. */
export class MeshtasticTcp {
  private sock?: net.Socket;
  private buf: Uint8Array = new Uint8Array(0);
  private backoff: Backoff;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private o: { host: string; port: number; retryMs?: number },
    private ingest: MeshtasticIngest,
  ) {
    this.backoff = new Backoff({ baseMs: o.retryMs ?? 3000 });
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.sock?.destroy();
  }

  /** Feed received bytes: deframe, bound the buffer, decode. */
  receive(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    const { frames, rest } = deframeMeshtastic(merged);
    this.buf = rest.length > MESHTASTIC_RX_MAX_BYTES ? new Uint8Array(0) : rest.slice();
    for (const f of frames) this.ingest.handle(parseFromRadio(f));
  }

  private connect(): void {
    if (this.stopped) return;
    this.buf = new Uint8Array(0);
    const s = net.connect(this.o.port, this.o.host);
    this.sock = s;
    s.on("connect", () => {
      this.backoff.reset();
      s.write(wantConfigFrame()); // node database (licence flags) first, then the live packet stream
      console.log(`[meshtastic] connected ${this.o.host}:${this.o.port}`);
    });
    s.on("data", (chunk: Buffer) => this.receive(Uint8Array.from(chunk)));
    s.on("error", () => console.log("[meshtastic] disconnected, retrying…"));
    s.on("close", () => {
      if (this.stopped || this.timer) return;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.connect();
      }, this.backoff.next());
    });
  }
}

/** Protobuf ServiceEnvelopes from an MQTT broker. */
export class MeshtasticMqtt {
  private mqtt: MqttSubscriber;

  constructor(
    o: { url: string; topic: string; clientId?: string },
    private ingest: MeshtasticIngest,
  ) {
    this.mqtt = new MqttSubscriber(
      { url: o.url, topics: [o.topic], clientId: o.clientId, name: "meshtastic-mqtt" },
      (_topic, payload) => this.ingest.handle(parseMeshServiceEnvelope(payload)),
    );
  }

  start(): void {
    this.mqtt.start();
  }

  stop(): void {
    this.mqtt.stop();
  }
}
