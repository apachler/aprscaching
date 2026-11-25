// SPDX-License-Identifier: AGPL-3.0-or-later
// What one client can pin in the Node server: a client that stops reading a response is dropped once a write has
// waited WRITE_STALL_MS, while a slow client that keeps reading gets the whole answer; a request body stays on the
// socket until the handler reads it, so an unknown path answers before the body arrives; and large bodies read at
// once are capped per client address and overall, past which the request is answered 503.
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { RoomsCore } from "@aprscaching/gateway/rooms-core";
import type { Env } from "@aprscaching/gateway/env";
import { instanceEnv } from "./helpers/fedpeer.js";
import { BodyGate, BODY_FREE_BYTES, BODY_SLOTS_PER_CLIENT } from "../src/bodygate.js";
import { createGatewayServer, type ListenerOptions } from "../src/listen.js";
import { fileTiles } from "../src/tiles.js";

const open: http.Server[] = [];
const sockets: net.Socket[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of open.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r)).catch(() => {});
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function listen(env: Env, opts: Partial<ListenerOptions> = {}): Promise<{ server: http.Server; port: number }> {
  const server = createGatewayServer({ env, rooms: new RoomsCore(), ...opts });
  open.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port };
}

const connections = (server: http.Server) =>
  new Promise<number>((resolve, reject) => server.getConnections((e, n) => (e ? reject(e) : resolve(n))));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An offline map archive of `mb` MiB, so one range answer (16 MiB at most) outgrows the sockets' buffers. */
function tilesEnv(mb = 20): Env {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acs-bounds-"));
  dirs.push(dir);
  const file = path.join(dir, "offline.pmtiles");
  fs.writeFileSync(file, Buffer.alloc(mb * 1024 * 1024, 0x5a));
  return instanceEnv("gw.test", null, { TILES: fileTiles(file) });
}

/** A raw connection that sends `head` (and `body`), then reads nothing until told to. */
function rawClient(port: number, head: string, body?: Buffer): { sock: net.Socket; received: () => string } {
  let got = "";
  const sock = net.connect(port, "127.0.0.1", () => {
    sock.write(head);
    if (body) sock.write(body);
  });
  sock.on("data", (c) => (got += c.toString("latin1")));
  sock.on("error", () => {});
  sockets.push(sock);
  return { sock, received: () => got };
}

describe("a client that never reads its answer", () => {
  it("is dropped once a write has waited the stall time, a 16 MiB tile range each", async () => {
    const { server, port } = await listen(tilesEnv(), { writeStallMs: 400 });
    for (let i = 0; i < 3; i++)
      rawClient(
        port,
        `GET /tiles/offline.pmtiles HTTP/1.1\r\nHost: gw.test\r\nRange: bytes=${i * 4096}-\r\n\r\n`,
      ).sock.pause();
    await sleep(300);
    expect(await connections(server)).toBe(3);
    await sleep(1500);
    // the server's own count of established connections: a paused client never sees the close
    expect(await connections(server)).toBe(0);
  });

  it("while a slow client that keeps reading gets all of it", async () => {
    const { port } = await listen(tilesEnv(), { writeStallMs: 400 });
    const total = await new Promise<number>((resolve, reject) => {
      http
        .get({ port, host: "127.0.0.1", path: "/tiles/offline.pmtiles", headers: { range: "bytes=0-" } }, (res) => {
          let n = 0;
          res.on("data", (c: Buffer) => {
            n += c.length;
            // read a little, then rest for less than the stall time
            res.pause();
            setTimeout(() => res.resume(), 5);
          });
          res.on("end", () => resolve(n));
          res.on("error", reject);
        })
        .on("error", reject);
    });
    expect(total).toBe(16 * 1024 * 1024);
  }, 30_000);
});

describe("a request body", () => {
  it("is not read before routing: an unknown path answers while its 20 MiB body is still coming", async () => {
    const { server, port } = await listen(instanceEnv("gw.test", null));
    const head = `POST /api/nothing HTTP/1.1\r\nHost: gw.test\r\nContent-Type: application/json\r\nContent-Length: ${20 * 1024 * 1024}\r\n\r\n`;
    const c = rawClient(port, head, Buffer.alloc(1024, 0x61));
    await sleep(500);
    expect(c.received()).toMatch(/^HTTP\/1\.1 404 /);
    expect(c.received()).toMatch(/\r\nconnection: close\r\n/i);
    await sleep(100);
    expect(await connections(server)).toBe(0);
  });

  it("is not read before the handler's own check: a frames page without the ingest secret", async () => {
    const { port } = await listen(instanceEnv("gw.test", null));
    const head = `POST /federation/frames HTTP/1.1\r\nHost: gw.test\r\nContent-Length: ${20 * 1024 * 1024}\r\n\r\n`;
    const c = rawClient(port, head, Buffer.alloc(1024, 0x61));
    await sleep(500);
    expect(c.received()).toMatch(/^HTTP\/1\.1 40[13] /);
  });

  it(`past ${BODY_FREE_BYTES / 1024} KiB holds a slot: a client gets ${BODY_SLOTS_PER_CLIENT} at once, then 503`, async () => {
    const gate = new BodyGate(8, BODY_SLOTS_PER_CLIENT);
    const { port } = await listen(instanceEnv("gw.test", null), { bodyGate: gate });
    // /auth/claim reads its JSON body whole; each client sends more than the free size, then stalls
    const head = `POST /auth/claim HTTP/1.1\r\nHost: gw.test\r\nContent-Type: application/json\r\nContent-Length: ${10 * 1024 * 1024}\r\n\r\n`;
    const held = Array.from({ length: BODY_SLOTS_PER_CLIENT }, () =>
      rawClient(port, head, Buffer.alloc(BODY_FREE_BYTES * 2, 0x20)),
    );
    await sleep(400);
    expect(gate.inUse).toBe(BODY_SLOTS_PER_CLIENT);
    const refused = rawClient(port, head, Buffer.alloc(BODY_FREE_BYTES * 2, 0x20));
    await sleep(400);
    expect(refused.received()).toMatch(/^HTTP\/1\.1 503 /);
    expect(refused.received()).toMatch(/\r\nretry-after: 5\r\n/i);
    for (const h of held) expect(h.received()).toBe("");
    // a client gone mid-body gives its slot back
    held[0]!.sock.destroy();
    await sleep(200);
    expect(gate.inUse).toBe(BODY_SLOTS_PER_CLIENT - 1);
  });

  it("past the free size takes one of the overall slots, whichever address it comes from", async () => {
    const gate = new BodyGate(2, 5);
    const { port } = await listen(instanceEnv("gw.test", null), { bodyGate: gate });
    const head = `POST /auth/claim HTTP/1.1\r\nHost: gw.test\r\nContent-Length: ${10 * 1024 * 1024}\r\n\r\n`;
    for (let i = 0; i < 2; i++) rawClient(port, head, Buffer.alloc(BODY_FREE_BYTES * 2, 0x20));
    await sleep(400);
    const refused = rawClient(port, head, Buffer.alloc(BODY_FREE_BYTES * 2, 0x20));
    await sleep(400);
    expect(refused.received()).toMatch(/^HTTP\/1\.1 503 /);
  });

  it("up to the free size needs no slot, and reaches its handler whole", async () => {
    const gate = new BodyGate(0, 0);
    const { port } = await listen(instanceEnv("gw.test", null), { bodyGate: gate });
    const res = await fetch(`http://127.0.0.1:${port}/auth/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callsign: "OE8APR", pad: " ".repeat(BODY_FREE_BYTES - 64) }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ callsign: "OE8APR" });
  });
});

describe("the body gate", () => {
  it("counts slots per client and overall, and a release frees exactly one", () => {
    const g = new BodyGate(3, 2);
    expect([g.acquire("a"), g.acquire("a"), g.acquire("a")]).toEqual([true, true, false]);
    expect([g.acquire("b"), g.acquire("c")]).toEqual([true, false]);
    g.release("a");
    expect(g.acquire("c")).toBe(true);
    g.release("nobody");
    expect(g.inUse).toBe(3);
  });
});
