// SPDX-License-Identifier: AGPL-3.0-or-later
// The live-room upgrade on the Node server bounds what one anonymous client can hold: a frame larger than a
// subscription closes the socket (1009) instead of being buffered, one client address holds at most
// LIVE_SOCKETS_PER_CLIENT sockets, and an upgrade whose Host header is no valid host is answered 400 and closed.
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { RoomsCore, LIVE_MESSAGE_MAX_BYTES, LIVE_SOCKETS_PER_CLIENT } from "@aprscaching/gateway/rooms-core";
import { instanceEnv } from "./helpers/fedpeer.js";
import { roomNamespace } from "../src/host.js";
import { createGatewayServer } from "../src/listen.js";

const servers: http.Server[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

async function start(): Promise<{ port: number; rooms: RoomsCore }> {
  const rooms = new RoomsCore({ heartbeatMs: 0 });
  const env = instanceEnv("localhost", null, { APP_URL: "http://localhost:8787", ROOMS: roomNamespace(rooms) });
  const server = createGatewayServer({ env, rooms });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, rooms };
}

/** Open a live socket; resolves once it is open, rejects with the HTTP status of a refused upgrade. */
function openWs(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?region=global`);
  sockets.push(ws);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once("error", reject);
  });
}

describe("the live socket", () => {
  it("closes with 1009 on a frame larger than LIVE_MESSAGE_MAX_BYTES", async () => {
    const { port } = await start();
    const ws = await openWs(port);
    const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
    ws.send("x".repeat(LIVE_MESSAGE_MAX_BYTES * 2));
    expect(await closed).toBe(1009);
  });

  it("still takes a subscription and delivers to it", async () => {
    const { port, rooms } = await start();
    const ws = await openWs(port);
    const got = new Promise<string>((r) => ws.once("message", (d) => r(String(d))));
    ws.send(JSON.stringify({ type: "subscribe", bbox: [15, 47, 16, 48], callsign: "OE8APR-9" }));
    await new Promise((r) => setTimeout(r, 50));
    rooms.dispatch("global", [{ station: { type: "station", callsign: "OE8APR", lat: 47.5, lon: 15.5, lastSeen: 1 } }]);
    expect(JSON.parse(await got)).toMatchObject({ type: "station", callsign: "OE8APR" });
  });

  it(`holds at most ${LIVE_SOCKETS_PER_CLIENT} sockets per client address`, async () => {
    const { port, rooms } = await start();
    for (let i = 0; i < LIVE_SOCKETS_PER_CLIENT; i++) await openWs(port);
    await expect(openWs(port)).rejects.toThrow(/HTTP 429/);
    expect(rooms.count("global")).toBe(LIVE_SOCKETS_PER_CLIENT);
    // a closed socket frees its place
    const first = sockets[0]!;
    first.close();
    await new Promise((r) => first.once("close", r));
    await new Promise((r) => setTimeout(r, 50));
    await openWs(port);
  });

  it("routes an upgrade by its path alone, whatever its Host header holds", async () => {
    const { port, rooms } = await start();
    const { reply, thrown } = await rawUpgrade(port, "/ws", "a b");
    expect(thrown).toEqual([]);
    expect(reply).toMatch(/^HTTP\/1\.1 101 /);
    expect(rooms.count("global")).toBe(1);
  });

  it("answers an upgrade whose target is no valid URL 400 and closes it, throwing nothing", async () => {
    const { port } = await start();
    const { reply, thrown, closed } = await rawUpgrade(port, "//[", "localhost");
    expect(thrown).toEqual([]);
    expect(closed).toBe(true);
    expect(reply).toMatch(/^HTTP\/1\.1 400 /);
  });
});

/** Send a WebSocket upgrade by hand (a client library would refuse these headers) and wait up to a second. */
async function rawUpgrade(
  port: number,
  target: string,
  host: string,
): Promise<{ reply: string; thrown: unknown[]; closed: boolean }> {
  const thrown: unknown[] = [];
  const onError = (e: unknown) => thrown.push(e);
  process.on("uncaughtException", onError);
  try {
    const sock = net.connect(port, "127.0.0.1");
    let reply = "";
    sock.on("data", (d) => (reply += String(d)));
    const closed = await new Promise<boolean>((resolve) => {
      sock.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 1000);
      sock.write(
        `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
      );
    });
    sock.destroy();
    return { reply, thrown, closed };
  } finally {
    process.off("uncaughtException", onError);
  }
}
