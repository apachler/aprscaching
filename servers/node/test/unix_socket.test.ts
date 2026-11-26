// SPDX-License-Identifier: AGPL-3.0-or-later
// The gateway's Unix socket (GATEWAY_SOCKET), the way a Pocket station's scripts and ingest reach it with a
// secret: a filesystem path in a directory only this user opens, never an abstract name; a socket file left
// by a killed gateway is replaced at start, a live one or any other file is not.
import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { RoomsCore } from "@aprscaching/gateway/rooms-core";
import { instanceEnv } from "./helpers/fedpeer.js";
import { roomNamespace } from "../src/host.js";
import { createGatewayServer } from "../src/listen.js";
import { listenUnix, socketPathError } from "../src/unixsocket.js";

const open: http.Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await new Promise((r) => s.close(r)).catch(() => {});
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "acs-sock-"));
  dirs.push(d);
  return d;
}

function gateway(): http.Server {
  const rooms = new RoomsCore();
  const env = instanceEnv("localhost", null, { APP_URL: "http://localhost:8787", ROOMS: roomNamespace(rooms) });
  const s = createGatewayServer({ env, rooms });
  open.push(s);
  return s;
}

function get(socketPath: string, p: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: p }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** A socket file whose listener was killed (SIGKILL: nothing removed it), as a crashed gateway leaves one. */
async function staleSocket(p: string): Promise<void> {
  const child = spawn(
    process.execPath,
    ["-e", `require("net").createServer().listen(${JSON.stringify(p)}, () => console.log("up"))`],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise<void>((r) => child.stdout.once("data", () => r()));
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
}

describe("the gateway's Unix socket", () => {
  it("serves the gateway on a path in a 0700 directory, the socket file 0600", async () => {
    const dir = path.join(tmp(), "run");
    const sock = path.join(dir, "gateway.sock");
    await listenUnix(gateway(), sock);
    expect(fs.lstatSync(sock).isSocket()).toBe(true);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(sock).mode & 0o777).toBe(0o600);
    const res = await get(sock, "/health");
    expect(res.status).toBe(200);
  });

  it("makes an existing directory private", async () => {
    const dir = path.join(tmp(), "run");
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    await listenUnix(gateway(), path.join(dir, "gateway.sock"));
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("replaces a socket file left by a killed gateway", async () => {
    const sock = path.join(tmp(), "gateway.sock");
    await staleSocket(sock);
    expect(fs.lstatSync(sock).isSocket()).toBe(true);
    await listenUnix(gateway(), sock);
    expect((await get(sock, "/health")).status).toBe(200);
  });

  it("refuses a socket another process still listens on", async () => {
    const sock = path.join(tmp(), "gateway.sock");
    await listenUnix(gateway(), sock);
    await expect(listenUnix(gateway(), sock)).rejects.toThrow(/another process listens/);
    expect((await get(sock, "/health")).status).toBe(200);
  });

  it("leaves a file that is not a socket and does not start", async () => {
    const sock = path.join(tmp(), "gateway.sock");
    fs.writeFileSync(sock, "keep me");
    await expect(listenUnix(gateway(), sock)).rejects.toThrow(/not a socket/);
    expect(fs.readFileSync(sock, "utf8")).toBe("keep me");
  });

  it("takes only an absolute filesystem path, never an abstract name", () => {
    expect(socketPathError("/data/run/gateway.sock")).toBeNull();
    expect(socketPathError("\0aprscaching")).toMatch(/abstract/);
    expect(socketPathError("@aprscaching")).toMatch(/abstract/);
    expect(socketPathError("run/gateway.sock")).toMatch(/absolute/);
    expect(socketPathError(`/${"x".repeat(120)}`)).toMatch(/107 bytes/);
  });
});
