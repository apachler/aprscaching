// SPDX-License-Identifier: AGPL-3.0-or-later
// The MQTT subscriber's session liveness: a broker that never answers CONNECT, goes silent, or refuses
// the subscription is dropped and re-dialled with backoff; one keepalive timer runs per session.
import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { MqttSubscriber } from "../src/mqtt.js";

const CONNACK = [0x20, 0x02, 0x00, 0x00];
const suback = (code: number) => [0x90, 0x03, 0x00, 0x01, code];

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20));
};

/** A fake broker: `answer` maps each packet type the client sends to the bytes to reply with. */
async function broker(answer: (type: number) => number[] | undefined) {
  let connections = 0;
  const received: number[] = [];
  const server = net.createServer((sock) => {
    connections++;
    sock.on("error", () => {});
    sock.on("data", (d) => {
      received.push(...d);
      const reply = answer(d[0]! >> 4);
      if (reply) sock.write(Uint8Array.from(reply));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `mqtt://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  return { url, server, connections: () => connections, received };
}

function subscriber(url: string, extra: Partial<ConstructorParameters<typeof MqttSubscriber>[0]> = {}) {
  const m = new MqttSubscriber({ url, topics: ["t"], clientId: "test", retryMs: 20, name: "test", ...extra }, () => {});
  return m;
}

describe("MqttSubscriber session liveness", () => {
  it("re-dials a broker that never answers CONNECT", async () => {
    const b = await broker(() => undefined);
    const m = subscriber(b.url, { connackTimeoutMs: 100 });
    cleanups.push(() => (m.stop(), b.server.close()));
    m.start();
    await until(() => b.connections() >= 2);
    expect(b.connections()).toBeGreaterThanOrEqual(2);
  });

  it("re-dials a broker that goes silent for 1.5 × the keepalive", async () => {
    const b = await broker((t) => (t === 1 ? CONNACK : t === 8 ? suback(0) : undefined)); // no PINGRESP
    const m = subscriber(b.url, { keepAliveSec: 1 });
    cleanups.push(() => (m.stop(), b.server.close()));
    m.start();
    await until(() => b.connections() >= 2, 4000);
    expect(b.connections()).toBeGreaterThanOrEqual(2);
  });

  it("treats a refused subscription as an error and keeps backing off", async () => {
    const b = await broker((t) => (t === 1 ? CONNACK : t === 8 ? suback(0x80) : undefined));
    const m = subscriber(b.url);
    cleanups.push(() => (m.stop(), b.server.close()));
    m.start();
    await until(() => b.connections() >= 3);
    expect(b.connections()).toBeGreaterThanOrEqual(3);
    // the backoff was never reset by the CONNACKs: each refused session escalated it
    expect((m as unknown as { backoff: { n: number } }).backoff.n).toBeGreaterThanOrEqual(2);
  });

  it("runs one keepalive timer per session, even when CONNACK arrives twice", async () => {
    const b = await broker((t) =>
      t === 1 ? [...CONNACK, ...CONNACK] : t === 8 ? suback(0) : t === 12 ? [0xd0, 0x00] : undefined,
    );
    const m = subscriber(b.url, { keepAliveSec: 1 });
    cleanups.push(() => (m.stop(), b.server.close()));
    m.start();
    await until(() => b.received.includes(0x82));
    const from = b.received.length;
    await new Promise((r) => setTimeout(r, 1200));
    const pings = b.received.slice(from).filter((x, i, a) => x === 0xc0 && a[i + 1] === 0x00).length;
    expect(pings).toBeGreaterThanOrEqual(1);
    expect(pings).toBeLessThanOrEqual(3); // one 500 ms timer; a leaked second one would double this
    expect(b.connections()).toBe(1);
  });
});
