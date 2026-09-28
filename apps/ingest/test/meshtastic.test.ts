// SPDX-License-Identifier: AGPL-3.0-or-later
// Meshtastic at the box: licensed nodes only, from the node's protobuf TCP API and from an MQTT broker.
import { describe, it, expect, vi, afterEach } from "vitest";
import net from "node:net";
import type { Packet } from "@aprscaching/shared";
import { MeshtasticIngest, MeshtasticTcp, MeshtasticMqtt, MESHTASTIC_RX_MAX_BYTES } from "../src/meshtastic.js";
import {
  encodeRemainingLength,
  connectPacket,
  subscribePacket,
  splitPackets,
  parsePublish,
  MQTT_MAX_PACKET,
} from "../src/mqtt.js";

// --- tiny protobuf builder (canonical Meshtastic field numbers) ---
function vb(n: number): number[] {
  const o: number[] = [];
  let v = n >>> 0;
  while (v > 0x7f) {
    o.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  o.push(v);
  return o;
}
const tag = (f: number, w: number) => vb((f << 3) | w);
const ld = (f: number, b: number[]) => [...tag(f, 2), ...vb(b.length), ...b];
const vf = (f: number, n: number) => [...tag(f, 0), ...vb(n)];
const fx = (f: number, n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n, true);
  return [...tag(f, 5), ...b];
};
const str = (s: string) => [...new TextEncoder().encode(s)];
const user = (name: string, licensed: boolean) => [...ld(2, str(name)), ...ld(3, str("X")), ...vf(6, licensed ? 1 : 0)];
const meshPacket = (from: number, portnum: number, payload: number[]) => [
  ...fx(1, from),
  ...ld(4, [...vf(1, portnum), ...ld(2, payload)]),
];
const position = (lat: number, lon: number) => [...fx(1, Math.round(lat * 1e7)), ...fx(2, Math.round(lon * 1e7))];
const frame = (body: number[]) => Uint8Array.from([0x94, 0xc3, body.length >> 8, body.length & 0xff, ...body]);
const nodeInfoFrame = (num: number, name: string, licensed: boolean) =>
  frame(ld(4, [...vf(1, num), ...ld(2, user(name, licensed))]));
const positionFrame = (from: number) => frame(ld(2, meshPacket(from, 3, position(47.07, 15.42))));
const envelope = (packet: number[]) => Uint8Array.from([...ld(1, packet), ...ld(2, str("LongFast"))]);

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20));
};

describe("MeshtasticIngest", () => {
  it("forwards a licensed node's positions under its callsign, trust-neutral", () => {
    const got: Packet[] = [];
    const m = new MeshtasticIngest(
      (p) => got.push(p),
      () => {},
    );
    m.handle({ kind: "nodeinfo", node: "!00000001", longName: "OE8APR-7", isLicensed: true });
    m.handle({ kind: "position", fix: { node: "!00000001", lat: 47.07, lon: 15.42 } });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ src: "OE8APR-7", heardVia: "aprs_is", port: "meshtastic", kind: "position" });
    expect(got[0]!.igateCall).toBeUndefined();
  });

  it("drops unlicensed and not-yet-known nodes, and says why once", () => {
    const log = vi.fn();
    const got: Packet[] = [];
    const m = new MeshtasticIngest((p) => got.push(p), log);
    m.handle({ kind: "position", fix: { node: "!00000001", lat: 47, lon: 15 } }); // NodeInfo not heard yet
    m.handle({ kind: "nodeinfo", node: "!00000002", longName: "Base Camp", isLicensed: false });
    m.handle({ kind: "position", fix: { node: "!00000002", lat: 47, lon: 15 } });
    expect(got).toHaveLength(0);
    expect(m.dropped).toBe(2);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("MeshtasticTcp (node TCP API)", () => {
  it("sends want_config, learns licences from the node database, forwards licensed positions", async () => {
    const got: Packet[] = [];
    let hello: number[] = [];
    const server = net.createServer((sock) => {
      sock.once("data", (d) => {
        hello = [...d];
        sock.write(
          Uint8Array.from([
            ...nodeInfoFrame(1, "OE8APR", true),
            ...nodeInfoFrame(2, "Base Camp", false),
            ...positionFrame(1),
            ...positionFrame(2),
          ]),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const t = new MeshtasticTcp(
      { host: "127.0.0.1", port: (server.address() as net.AddressInfo).port },
      new MeshtasticIngest(
        (p) => got.push(p),
        () => {},
      ),
    );
    cleanups.push(() => (t.stop(), server.close()));
    t.start();
    await until(() => got.length > 0);
    expect(hello.slice(0, 2)).toEqual([0x94, 0xc3]);
    expect(hello[4]).toBe(0x18); // ToRadio.want_config_id
    expect(got.map((p) => p.src)).toEqual(["OE8APR"]);
  });

  it("keeps its receive buffer bounded", () => {
    const t = new MeshtasticTcp(
      { host: "127.0.0.1", port: 1 },
      new MeshtasticIngest(
        () => {},
        () => {},
      ),
    );
    t.receive(new Uint8Array(MESHTASTIC_RX_MAX_BYTES + 1024).fill(0x94));
    expect((t as unknown as { buf: Uint8Array }).buf.length).toBeLessThanOrEqual(MESHTASTIC_RX_MAX_BYTES);
  });

  it("reconnects after the node drops the connection", async () => {
    let connections = 0;
    const server = net.createServer((sock) => {
      connections++;
      sock.destroy();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const t = new MeshtasticTcp(
      { host: "127.0.0.1", port: (server.address() as net.AddressInfo).port, retryMs: 20 },
      new MeshtasticIngest(
        () => {},
        () => {},
      ),
    );
    cleanups.push(() => (t.stop(), server.close()));
    t.start();
    await until(() => connections >= 2);
    expect(connections).toBeGreaterThanOrEqual(2);
  });
});

describe("MQTT subscriber", () => {
  it("encodes the remaining length and the CONNECT / SUBSCRIBE packets", () => {
    expect(encodeRemainingLength(0)).toEqual([0]);
    expect(encodeRemainingLength(127)).toEqual([127]);
    expect(encodeRemainingLength(128)).toEqual([0x80, 0x01]);
    expect(encodeRemainingLength(16384)).toEqual([0x80, 0x80, 0x01]);
    const c = connectPacket({ clientId: "c", username: "u", password: "p", keepAliveSec: 60 });
    expect(Array.from(c.subarray(0, 12))).toEqual([0x10, 19, 0, 4, 77, 81, 84, 84, 4, 0xc2, 0, 60]);
    expect(Array.from(subscribePacket(1, ["a"]))).toEqual([0x82, 6, 0, 1, 0, 1, 97, 0]);
  });

  it("splits a stream into packets, waits for partial ones, rejects oversized ones", () => {
    const pub = Uint8Array.from([0x30, 5, 0, 1, 116, 104, 105]); // topic "t", payload "hi"
    const split = splitPackets(Uint8Array.from([...pub, 0x30, 5, 0]))!;
    expect(split.packets).toHaveLength(1);
    expect(split.rest.length).toBe(3);
    expect(parsePublish(split.packets[0]!)).toEqual({ topic: "t", payload: Uint8Array.from([104, 105]) });
    const big = encodeRemainingLength(MQTT_MAX_PACKET + 1);
    expect(splitPackets(Uint8Array.from([0x30, ...big]))).toBeNull();
    const qos1 = splitPackets(Uint8Array.from([0x32, 6, 0, 1, 116, 0, 9, 104]))!.packets[0]!;
    expect(parsePublish(qos1)).toEqual({ topic: "t", id: 9, payload: Uint8Array.from([104]) });
  });

  it("reads protobuf ServiceEnvelopes from a broker and acks QoS 1 deliveries", async () => {
    const got: Packet[] = [];
    const received: number[][] = [];
    const publish = (topic: string, payload: Uint8Array, id: number) => {
      const body = [...[topic.length >> 8, topic.length & 0xff, ...str(topic)], id >> 8, id & 0xff, ...payload];
      return Uint8Array.from([0x32, ...encodeRemainingLength(body.length), ...body]);
    };
    const server = net.createServer((sock) => {
      sock.on("data", (d) => {
        received.push([...d]);
        if (d[0] === 0x10) sock.write(Uint8Array.from([0x20, 0x02, 0x00, 0x00])); // CONNACK ok
        if (d[0] === 0x82) {
          sock.write(Uint8Array.from([0x90, 0x03, 0x00, 0x01, 0x00])); // SUBACK
          const t = "msh/EU_868/2/e/LongFast/!gw";
          sock.write(publish(t, envelope(meshPacket(1, 4, user("OE8APR-9", true))), 1));
          sock.write(publish(t, envelope(meshPacket(1, 3, position(47.07, 15.42))), 2));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    const m = new MeshtasticMqtt(
      { url: `mqtt://meshdev:large4cats@127.0.0.1:${port}`, topic: "msh/#", clientId: "test" },
      new MeshtasticIngest(
        (p) => got.push(p),
        () => {},
      ),
    );
    cleanups.push(() => (m.stop(), server.close()));
    m.start();
    await until(() => got.length > 0 && received.some((r) => r[0] === 0x40 && r[3] === 2));
    expect(got.map((p) => p.src)).toEqual(["OE8APR-9"]);
    const sub = received.find((r) => r[0] === 0x82)!;
    expect(new TextDecoder().decode(Uint8Array.from(sub.slice(6, 11)))).toBe("msh/#");
    expect(received.some((r) => r[0] === 0x40 && r[3] === 1)).toBe(true); // PUBACK for both QoS 1 messages
  });
});
