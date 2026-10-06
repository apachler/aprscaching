// SPDX-License-Identifier: AGPL-3.0-or-later
// The Bun server holds the Node server's limits: a request body stops at BODY_MAX_BYTES, a failure answers a
// generic JSON 500 (never Bun's error page), the https listener settings it has no listener for stop the boot,
// and tool-registry fetches get their own guard. Run with `bun test servers/bun/test` (the CI Bun conformance).
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type BunServer } from "../server.ts";
import { migrationsFromDir } from "../../node/src/migrate.ts";
import { BODY_MAX_BYTES } from "../../node/src/host.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = migrationsFromDir(join(HERE, "../../../db/migrations"));
const SECRETS = {
  INGEST_SECRET: "bun-test-ingest-secret-0123456789",
  SESSION_SECRET: "bun-test-session-secret-0123456789",
};
const BASE_ENV = { UPDATE_CHECK: "0", FED_SYNC_INTERVAL_MS: "0", FED_RELAY_POLL_MS: "0", FED_MDNS: "off" };

const started: BunServer[] = [];
afterAll(() => {
  for (const s of started) void s.server.stop(true);
});

function start(environment: Record<string, string> = {}, spa?: (p: string) => Response): BunServer {
  const dir = mkdtempSync(join(tmpdir(), "acs-bun-"));
  const s = createServer({
    environment: { ...BASE_ENV, ...environment },
    port: 0,
    hostname: "127.0.0.1",
    dbPath: join(dir, "test.db"),
    mediaDir: join(dir, "media"),
    migrations: MIGRATIONS,
    secrets: SECRETS,
    spa,
  });
  started.push(s);
  return s;
}
const base = (s: BunServer) => `http://127.0.0.1:${s.server.port}`;

describe("the https listener settings", () => {
  for (const key of ["HTTPS_PORT", "TLS_CERT", "TLS_KEY", "TLS_CA_CERT"])
    it(`refuse to start with ${key} set`, () => {
      expect(() => start({ [key]: key === "HTTPS_PORT" ? "8443" : "/etc/ssl/x.pem" })).toThrow(
        /read by the Node server only/,
      );
    });

  it("start with them blank", () => {
    expect(start({ HTTPS_PORT: "", TLS_CERT: " " }).server.port).toBeGreaterThan(0);
  });
});

describe("a request", () => {
  it("whose body passes BODY_MAX_BYTES is refused 413", async () => {
    const s = start();
    // a route with no cap of its own, which would read any body the server let through
    const res = await fetch(`${base(s)}/api/caches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array(BODY_MAX_BYTES + 1024 * 1024),
    });
    expect(res.status).toBe(413);
  });

  it("that fails inside the gateway answers a generic JSON 500", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    const s = start();
    const boom = () => {
      throw new Error("SQLITE_CORRUPT at /srv/aprscaching/data/aprscaching.db");
    };
    const db = s.env.DB;
    s.env.DB = { prepare: boom, batch: boom, exec: boom } as unknown as typeof db;
    try {
      const res = await fetch(`${base(s)}/api/caches/1`);
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      expect(await res.text()).toBe(JSON.stringify({ error: "internal error" }));
    } finally {
      s.env.DB = db;
      logged.mockRestore();
    }
  });

  it("that fails outside it answers the same, never Bun's error page", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    const s = start({}, () => {
      throw new Error("a stack that must stay on the server");
    });
    try {
      const res = await fetch(`${base(s)}/some/app/route`);
      expect(res.status).toBe(500);
      expect(await res.text()).toBe(JSON.stringify({ error: "internal error" }));
    } finally {
      logged.mockRestore();
    }
  });
});

describe("tool-registry fetches", () => {
  it("refuse private targets whatever FED_ALLOW_PRIVATE and FED_PEERS allow federation", async () => {
    const s = start({ FED_ALLOW_PRIVATE: "1", FED_PEERS: "https://10.0.0.7" });
    await s.env.FED_FETCH_GUARD!("https://10.0.0.7/x");
    for (const url of ["https://10.0.0.7/x", "https://192.168.1.5/x", "https://[::1]/x", "https://127.0.0.1/x"])
      await expect(s.env.TOOL_FETCH_GUARD!(url)).rejects.toThrow(/refused/);
  });
});
