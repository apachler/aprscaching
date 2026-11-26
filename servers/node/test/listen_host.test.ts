// SPDX-License-Identifier: AGPL-3.0-or-later
// HOST binds the Node server's plain and https listeners to one address. Behind a reverse proxy on the same
// machine HOST=127.0.0.1 makes the proxy the only way in: a client that could reach the gateway's port
// directly would choose its own X-Forwarded-For. 127.0.0.2 is another loopback address on Linux, so a
// listener on every interface answers there and one bound to 127.0.0.1 does not.
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasOpenssl, makePki } from "./helpers/tls.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "../src/server.ts");
const TSX = path.join(HERE, "../node_modules/.bin/tsx");

const running: ChildProcess[] = [];
afterEach(() => {
  for (const p of running.splice(0)) p.kill("SIGKILL");
});

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as net.AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

/** Start server.ts and wait until both listeners are up; rejects with the server's output if it exits. */
async function boot(env: Record<string, string>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acs-host-"));
  const child = spawn(TSX, [SERVER], {
    env: {
      PATH: process.env.PATH ?? "",
      DB_PATH: path.join(dir, "gw.db"),
      MEDIA_DIR: path.join(dir, "media"),
      INGEST_SECRET: "listen-host-ingest-secret-0123456789",
      UPDATE_CHECK: "0",
      DEVICEID_URL: "",
      FED_SYNC_INTERVAL_MS: "0",
      FED_RELAY_POLL_MS: "0",
      FED_MDNS: "off",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.push(child);
  let out = "";
  await new Promise<void>((resolve, reject) => {
    const seen = () => {
      if (/https on /.test(out) && /listening on /.test(out)) resolve();
    };
    child.stdout!.on("data", (d) => ((out += d), seen()));
    child.stderr!.on("data", (d) => (out += d));
    child.on("exit", (code) => reject(new Error(`server exited ${code}:\n${out}`)));
  });
}

/** Whether a TCP connection to host:port is accepted. */
function accepts(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(port, host);
    sock.once("connect", () => (sock.destroy(), resolve(true)));
    sock.once("error", () => resolve(false));
  });
}

describe.skipIf(!hasOpenssl || process.platform !== "linux")("HOST binds the Node server's listeners", () => {
  async function listeners(host?: string) {
    const [plain, secure] = [await freePort(), await freePort()];
    const pki = makePki(["127.0.0.1"]);
    await boot({
      PORT: String(plain),
      HTTPS_PORT: String(secure),
      TLS_CERT: pki.cert,
      TLS_KEY: pki.key,
      ...(host ? { HOST: host } : {}),
    });
    return { plain, secure };
  }

  it("HOST=127.0.0.1: both listeners answer on 127.0.0.1 and refuse another local address", async () => {
    const { plain, secure } = await listeners("127.0.0.1");
    expect(await accepts("127.0.0.1", plain)).toBe(true);
    expect(await accepts("127.0.0.1", secure)).toBe(true);
    expect(await accepts("127.0.0.2", plain)).toBe(false);
    expect(await accepts("127.0.0.2", secure)).toBe(false);
  });

  it("unset: both listeners answer on every interface", async () => {
    const { plain, secure } = await listeners();
    expect(await accepts("127.0.0.2", plain)).toBe(true);
    expect(await accepts("127.0.0.2", secure)).toBe(true);
  });
});
