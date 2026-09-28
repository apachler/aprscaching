// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * mqtt.ts — a minimal MQTT 3.1.1 subscriber: connect (optionally TLS, optionally with a username and
 * password), subscribe at QoS 0, deliver PUBLISH payloads, keep the session alive with PINGREQ, and
 * reconnect with backoff. It never publishes. Just enough for reading a broker's feed without a
 * third-party client library on the box.
 */
import net from "node:net";
import tls from "node:tls";
import { Backoff } from "./backoff.js";

/** A packet declaring more than this is not a feed we read: the connection is dropped and re-opened. */
export const MQTT_MAX_PACKET = 256 * 1024;

export interface MqttOpts {
  /** `mqtt://[user[:pass]@]host[:1883]` or `mqtts://…[:8883]`. */
  url: string;
  topics: string[];
  clientId?: string;
  keepAliveSec?: number;
  retryMs?: number;
  /** Log tag. */
  name?: string;
}

const enc = new TextEncoder();

/** MQTT variable-length "remaining length". */
export function encodeRemainingLength(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
}

const str = (s: string): number[] => {
  const b = enc.encode(s);
  return [b.length >> 8, b.length & 0xff, ...b];
};

/** CONNECT with a clean session. */
export function connectPacket(o: {
  clientId: string;
  username?: string;
  password?: string;
  keepAliveSec: number;
}): Uint8Array {
  let flags = 0x02;
  if (o.username != null) flags |= 0x80;
  if (o.password != null) flags |= 0x40;
  const variable = [...str("MQTT"), 4, flags, o.keepAliveSec >> 8, o.keepAliveSec & 0xff];
  const payload = [
    ...str(o.clientId),
    ...(o.username != null ? str(o.username) : []),
    ...(o.password != null ? str(o.password) : []),
  ];
  const body = [...variable, ...payload];
  return Uint8Array.from([0x10, ...encodeRemainingLength(body.length), ...body]);
}

/** SUBSCRIBE every topic at QoS 0. */
export function subscribePacket(id: number, topics: string[]): Uint8Array {
  const body = [id >> 8, id & 0xff, ...topics.flatMap((t) => [...str(t), 0])];
  return Uint8Array.from([0x82, ...encodeRemainingLength(body.length), ...body]);
}

export type MqttPacket = { type: number; flags: number; body: Uint8Array };

/**
 * Split a byte stream into complete MQTT packets. Returns null when a packet declares more than
 * {@link MQTT_MAX_PACKET} (or a malformed length), which the caller treats as a broken stream.
 */
export function splitPackets(buf: Uint8Array): { packets: MqttPacket[]; rest: Uint8Array } | null {
  const packets: MqttPacket[] = [];
  let i = 0;
  while (i + 2 <= buf.length) {
    let len = 0,
      mult = 1,
      p = i + 1,
      done = false;
    for (let k = 0; k < 4 && p < buf.length; k++, p++) {
      len += (buf[p]! & 0x7f) * mult;
      mult *= 128;
      if (!(buf[p]! & 0x80)) {
        done = true;
        p++;
        break;
      }
    }
    if (!done) {
      if (p - (i + 1) >= 4) return null; // more than four length bytes: malformed
      break; // length not complete yet
    }
    if (len > MQTT_MAX_PACKET) return null;
    if (p + len > buf.length) break;
    packets.push({ type: buf[i]! >> 4, flags: buf[i]! & 0x0f, body: buf.subarray(p, p + len) });
    i = p + len;
  }
  return { packets, rest: buf.subarray(i) };
}

/** A PUBLISH packet's topic, packet id (QoS > 0) and payload. */
export function parsePublish(pkt: MqttPacket): { topic: string; id?: number; payload: Uint8Array } | null {
  const b = pkt.body;
  if (b.length < 2) return null;
  const tlen = (b[0]! << 8) | b[1]!;
  if (2 + tlen > b.length) return null;
  const topic = new TextDecoder().decode(b.subarray(2, 2 + tlen));
  const qos = (pkt.flags >> 1) & 3;
  let p = 2 + tlen;
  let id: number | undefined;
  if (qos > 0) {
    if (p + 2 > b.length) return null;
    id = (b[p]! << 8) | b[p + 1]!;
    p += 2;
  }
  return { topic, ...(id != null ? { id } : {}), payload: b.subarray(p) };
}

export class MqttSubscriber {
  private sock?: net.Socket;
  private buf: Uint8Array = new Uint8Array(0);
  private backoff: Backoff;
  private ping?: ReturnType<typeof setInterval>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private readonly name: string;

  constructor(
    private o: MqttOpts,
    private onMessage: (topic: string, payload: Uint8Array) => void,
  ) {
    this.backoff = new Backoff({ baseMs: o.retryMs ?? 3000 });
    this.name = o.name ?? "mqtt";
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.ping) clearInterval(this.ping);
    if (this.timer) clearTimeout(this.timer);
    this.sock?.destroy();
  }

  private connect(): void {
    if (this.stopped) return;
    const u = new URL(this.o.url);
    const secure = u.protocol === "mqtts:";
    const port = Number(u.port) || (secure ? 8883 : 1883);
    const host = u.hostname;
    this.buf = new Uint8Array(0);
    const s = secure ? tls.connect({ host, port, servername: host }) : net.connect(port, host);
    this.sock = s;
    const keepAliveSec = this.o.keepAliveSec ?? 60;
    s.on(secure ? "secureConnect" : "connect", () => {
      s.write(
        connectPacket({
          clientId: this.o.clientId ?? `aprscaching-${Math.random().toString(36).slice(2, 10)}`,
          ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
          ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
          keepAliveSec,
        }),
      );
    });
    s.on("data", (chunk: Buffer) => this.receive(Uint8Array.from(chunk), keepAliveSec));
    s.on("error", (e: Error) => console.log(`[${this.name}] ${e.message}, retrying…`));
    s.on("close", () => {
      if (this.ping) clearInterval(this.ping);
      this.ping = undefined;
      if (this.stopped || this.timer) return;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.connect();
      }, this.backoff.next());
    });
  }

  private receive(chunk: Uint8Array, keepAliveSec: number): void {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    const split = splitPackets(merged);
    if (!split) {
      console.log(`[${this.name}] oversized or malformed packet — reconnecting`);
      this.sock?.destroy();
      return;
    }
    this.buf = split.rest.slice();
    for (const pkt of split.packets) {
      if (pkt.type === 2) {
        // CONNACK: return code in the second byte
        if (pkt.body[1] !== 0) {
          console.log(`[${this.name}] broker refused the connection (code ${pkt.body[1]})`);
          this.sock?.destroy();
          return;
        }
        this.backoff.reset();
        this.sock?.write(subscribePacket(1, this.o.topics));
        this.ping = setInterval(() => this.sock?.write(Uint8Array.from([0xc0, 0x00])), (keepAliveSec * 1000) / 2);
        this.ping.unref?.();
        console.log(`[${this.name}] connected, subscribed to ${this.o.topics.join(", ")}`);
      } else if (pkt.type === 3) {
        const pub = parsePublish(pkt);
        if (!pub) continue;
        if (pub.id != null) this.sock?.write(Uint8Array.from([0x40, 0x02, pub.id >> 8, pub.id & 0xff])); // PUBACK
        this.onMessage(pub.topic, pub.payload);
      }
    }
  }
}
