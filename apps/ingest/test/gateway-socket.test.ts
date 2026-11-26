// SPDX-License-Identifier: AGPL-3.0-or-later
// With GATEWAY_SOCKET set (a Pocket station), every gateway request the ingest makes — the packet delivery with
// INGEST_SECRET included — goes through that Unix socket and never to a TCP port. On a phone another app may
// hold the gateway's TCP port while it is free and would receive the secret.
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { gatewayFetch } from "../src/gatewayauth.js";

interface Seen {
  method?: string;
  url?: string;
  secret?: string;
  body: string;
}

let dir = "";
let squatter: net.Server;
let squatted: string[] = [];
let gateway: http.Server;
let seen: Seen[] = [];
let port = 0;
let sock = "";

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "acs-ing-"));
  sock = path.join(dir, "gateway.sock");
  squatted = [];
  seen = [];
  // Another app on the phone, holding the gateway's TCP port: it records whatever reaches it and answers.
  squatter = net.createServer((c) =>
    c.on("data", (d: Buffer) => {
      squatted.push(d.toString());
      c.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
    }),
  );
  await new Promise<void>((r) => squatter.listen(0, "127.0.0.1", r));
  port = (squatter.address() as net.AddressInfo).port;
  gateway = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        secret: req.headers["x-ingest-secret"] as string | undefined,
        body: Buffer.concat(chunks).toString(),
      });
      res.writeHead(202, { "content-type": "application/json", "x-test": "1" }).end('{"accepted":1}');
    });
  });
  await new Promise<void>((r) => gateway.listen(sock, r));
  process.env.GATEWAY_SOCKET = sock;
});

afterEach(async () => {
  delete process.env.GATEWAY_SOCKET;
  await new Promise((r) => squatter.close(r));
  await new Promise((r) => gateway.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("gateway requests over GATEWAY_SOCKET", () => {
  it("delivers a batch with INGEST_SECRET through the socket and sends nothing to the TCP port", async () => {
    const res = await gatewayFetch(`http://127.0.0.1:${port}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ingest-secret": "dummy-ingest-secret" },
      body: '{"packets":[]}',
    });
    expect(squatted.join("")).not.toContain("dummy-ingest-secret");
    expect(res.status).toBe(202);
    expect(res.headers.get("x-test")).toBe("1");
    expect(await res.json()).toEqual({ accepted: 1 });
    expect(seen).toEqual([{ method: "POST", url: "/ingest", secret: "dummy-ingest-secret", body: '{"packets":[]}' }]);
    await new Promise((r) => setTimeout(r, 100));
    expect(squatted).toEqual([]);
  });

  it("keeps the path and query of the URL, and sends bytes as they are", async () => {
    await gatewayFetch(`http://127.0.0.1:${port}/outbox/ack?x=1`, {
      method: "POST",
      headers: { "x-ingest-secret": "s" },
      body: new Uint8Array([104, 105]),
    });
    expect(seen[0]).toMatchObject({ url: "/outbox/ack?x=1", body: "hi" });
    expect(squatted).toEqual([]);
  });

  it("fails, rather than reaching TCP, when nothing listens on the socket", async () => {
    await new Promise((r) => gateway.close(r));
    gateway = http.createServer();
    await expect(
      gatewayFetch(`http://127.0.0.1:${port}/ingest`, {
        method: "POST",
        headers: { "x-ingest-secret": "s" },
        body: "{}",
      }),
    ).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 100));
    expect(squatted).toEqual([]);
  });

  it("gives up after the request's own signal", async () => {
    await new Promise((r) => gateway.close(r));
    gateway = http.createServer(() => {}); // accepts and never answers
    await new Promise<void>((r) => gateway.listen(sock, r));
    await expect(
      gatewayFetch(`http://127.0.0.1:${port}/ingest/check`, { signal: AbortSignal.timeout(200) }),
    ).rejects.toThrow();
  });
});
