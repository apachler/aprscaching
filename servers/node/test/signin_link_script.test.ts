// SPDX-License-Identifier: AGPL-3.0-or-later
// tools/admin/signin-link.mjs against a running gateway: `--link-origin` names the origin the link carries (the
// gateway refuses any but APP_URL and the station's hotspot origin), and `--qr` prints it for a phone.
import { describe, it, expect, afterAll } from "vitest";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { RoomsCore } from "@aprscaching/gateway/rooms-core";
import { instanceEnv } from "./helpers/fedpeer.js";
import { createGatewayServer } from "../src/listen.js";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../tools/admin/signin-link.mjs");

const server = createGatewayServer({
  env: instanceEnv("localhost", null, {
    APP_URL: "http://localhost:8787",
    ADMIN_CALLSIGNS: "OE8APR",
    HTTPS_LISTENER_PORT: "8443",
    OPERATOR_LINKS_FOR_ANY_CALL: "1",
  }),
  rooms: new RoomsCore(),
});
const ready = new Promise<number>((r) =>
  server.listen(0, "127.0.0.1", () => r((server.address() as AddressInfo).port)),
);
afterAll(() => new Promise((r) => server.close(r)));

async function run(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const port = await ready;
  return new Promise((resolve) =>
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env: { ...process.env, BASE: `http://127.0.0.1:${port}`, OPERATOR_SECRET: "test-operator-secret" } },
      (e, out, err) => resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err }),
    ),
  );
}

describe("signin-link.mjs", () => {
  it("names the hotspot origin with --link-origin, and prints a QR with --qr", async () => {
    const r = await run("--link-origin", "https://192.168.43.1:8443", "--qr", "oe8vis");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^https:\/\/192\.168\.43\.1:8443\/auth\/email\/verify\?token=[0-9a-f]{64}$/m);
    const qr = r.out.split("\n").filter((l) => /^[█▀▄ ]+$/.test(l));
    expect(qr.length).toBeGreaterThan(20);
    expect(qr[0]).toBe("█".repeat(qr[0]!.length)); // the light quiet zone
  });

  it("names APP_URL without --link-origin", async () => {
    const r = await run("--link-origin=http://localhost:8787", "OE8VIS");
    expect(r.out).toMatch(/^http:\/\/localhost:8787\/auth\/email\/verify\?token=/m);
    const d = await run("OE8VIS");
    expect(d.out).toMatch(/^http:\/\/localhost:8787\/auth\/email\/verify\?token=/m);
  });

  it("fails on an origin the gateway refuses", async () => {
    const r = await run("--link-origin", "https://evil.test", "OE8VIS");
    expect(r.code).toBe(1);
    expect(r.err).toContain("refused (400)");
  });

  it("rejects an unknown option", async () => {
    expect((await run("--bse", "x", "OE8VIS")).code).toBe(2);
  });
});
