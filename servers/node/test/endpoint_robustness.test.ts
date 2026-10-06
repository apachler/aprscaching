// SPDX-License-Identifier: AGPL-3.0-or-later
// The endpoint and runtime limits every instance holds: a failure answers a generic JSON 500 from handle() and
// from the Node bridge, a request body stops at its cap before it is buffered whole, the summary's queries stay
// on their indexes and its pages stay small, and a summary honours `for` only for a peer this instance knows.
import { afterEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { format } from "node:util";
import type { AddressInfo } from "node:net";
import { RoomsCore } from "@aprscaching/gateway/rooms-core";
/** Origins one summary page lists (fedtransit.ts). */
const SUMMARY_PAGE = 100;
import type { Env } from "@aprscaching/gateway/env";
import { freshDb, instanceEnv, newFedKey, serve } from "./helpers/fedpeer.js";
import { BODY_MAX_BYTES } from "../src/host.js";
import { createGatewayServer } from "../src/listen.js";

const open: http.Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of open.splice(0)) await new Promise((r) => s.close(r)).catch(() => {});
});

const INGEST = { "x-ingest-secret": "test-ingest-secret" };

/** An env whose database fails every statement with a message that must never reach a client. */
function brokenEnv(): Env {
  const env = instanceEnv("gw.test", null, { APP_URL: "https://gw.test" });
  const boom = () => {
    throw new Error("SQLITE_CORRUPT at /srv/aprscaching/data/aprscaching.db");
  };
  return { ...env, DB: { prepare: boom, batch: boom, exec: boom } } as unknown as Env;
}

async function listen(env: Env): Promise<number> {
  const server = createGatewayServer({ env, rooms: new RoomsCore() });
  open.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

function post(port: number, path: string, size: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, host: "127.0.0.1", path, method: "POST" }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    // the server may answer and close before the whole body is written
    req.on("error", (e) => ((e as NodeJS.ErrnoException).code === "EPIPE" ? undefined : reject(e)));
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    let left = size;
    const write = () => {
      while (left > 0) {
        const n = Math.min(left, chunk.length);
        left -= n;
        if (!req.write(n === chunk.length ? chunk : chunk.subarray(0, n))) return void req.once("drain", write);
      }
      req.end();
    };
    write();
  });
}

describe("a failure inside the gateway", () => {
  it("answers a generic JSON 500 from handle(), logs the error, and keeps CORS", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await serve(brokenEnv())(
      new Request("https://gw.test/api/caches/1", { headers: { origin: "https://gw.test" } }),
    );
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://gw.test");
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: "internal error" });
    expect(body).not.toMatch(/SQLITE|\/srv/);
    expect(format(...(logged.mock.calls[0] as [unknown, ...unknown[]]))).toMatch(/SQLITE_CORRUPT/);
  });

  it("answers the same over the Node server's listener", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const port = await listen(brokenEnv());
    const got = await new Promise<{ status: number; body: string }>((resolve, reject) =>
      http
        .get({ port, host: "127.0.0.1", path: "/api/caches/1" }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        })
        .on("error", reject),
    );
    expect(got).toEqual({ status: 500, body: JSON.stringify({ error: "internal error" }) });
  });
});

describe("request bodies", () => {
  it("stop at BODY_MAX_BYTES on the Node server, answered 413", async () => {
    const port = await listen(instanceEnv("gw.test", null));
    const r = await post(port, "/federation/frames", BODY_MAX_BYTES + 1024 * 1024);
    expect(r.status).toBe(413);
    expect(JSON.parse(r.body)).toEqual({ error: "request body too large" });
  });

  it("a heard sync page and a heard datagram are read only up to their caps", async () => {
    const env = instanceEnv("gw.test", null);
    // a body that would never end: the reader must stop at the cap, not buffer it whole
    let pulled = 0;
    const endless = () =>
      new ReadableStream<Uint8Array>({
        pull(c) {
          pulled += 64 * 1024;
          c.enqueue(new Uint8Array(64 * 1024));
        },
      });
    const send = (path: string) =>
      serve(env)(
        new Request(`https://gw.test${path}`, {
          method: "POST",
          headers: INGEST,
          body: endless(),
          duplex: "half",
        } as RequestInit),
      );
    const page = await send("/federation/frames");
    expect(page.status).toBe(413);
    expect(pulled).toBeLessThan(5 * 1024 * 1024);
    pulled = 0;
    const datagram = await send("/federation/beacon");
    expect(datagram.status).toBe(413);
    expect(pulled).toBeLessThan(256 * 1024);
    // a declared length past the cap is refused before a byte is read
    pulled = 0;
    const declared = await serve(env)(
      new Request("https://gw.test/federation/frames", {
        method: "POST",
        headers: { ...INGEST, "content-length": String(64 * 1024 * 1024) },
        body: endless(),
        duplex: "half",
      } as RequestInit),
    );
    expect(declared.status).toBe(413);
  });
});

describe("the summary's cost", () => {
  const plan = (sql: string) => {
    const { sqlite } = freshDb();
    return (sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail).join(" | ");
  };

  it("finds an origin's newest frame that may pass on along the index, without a sort or a row read", () => {
    const p = plan(
      "SELECT v FROM fed_transit WHERE origin = 'a' AND kind = 'cache' AND hops < 4 ORDER BY v DESC LIMIT 1",
    );
    expect(p).toMatch(/USING COVERING INDEX idx_fed_transit_origin/);
    expect(p).not.toMatch(/TEMP B-TREE/);
  });

  it("checks a blocked or trusted origin on an index over every peer row", () => {
    for (const trust of ["blocked", "trusted"]) {
      const p = plan(`SELECT 1 FROM fed_peers b WHERE b.instance = 'a' AND b.trust = '${trust}'`);
      expect(p, trust).toMatch(/USING COVERING INDEX idx_fed_peers_instance_trust/);
    }
  });

  it("reports the newest frame below the hop limit, and lists at most SUMMARY_PAGE origins a page", async () => {
    const key = await newFedKey();
    const env = instanceEnv("hub.example", key);
    const other = await newFedKey();
    const n = SUMMARY_PAGE + 5;
    for (let i = 0; i < n; i++) {
      const origin = `o${String(i).padStart(4, "0")}.example`;
      await env.DB.prepare("INSERT INTO fed_peers (url, instance, public_key, trust) VALUES (?, ?, ?, 'trusted')")
        .bind(`https://${origin}`, origin, other.pub)
        .run();
      await env.DB.prepare(
        "INSERT INTO fed_origin_marks (origin, kind, seq, region, updated_at) VALUES (?, 'cache', 5, '', 0)",
      )
        .bind(origin)
        .run();
    }
    const frame = (gid: string, v: number, hops: number) =>
      env.DB.prepare(
        `INSERT INTO fed_transit (gid, origin, kind, v, frame, signer_key, via, hops, received_at)
         VALUES (?, 'o0000.example', 'cache', ?, x'00', ?, 'o0000.example', ?, 0)`,
      )
        .bind(gid, v, other.pub, hops)
        .run();
    await frame("o0000.example:cache:1", 10, 1);
    await frame("o0000.example:cache:2", 20, 4); // kept, never passed on
    const get = async (q: string) =>
      (await (await serve(env)(new Request(`https://hub.example/federation/sync/summary${q}`))).json()) as {
        origins: { origin: string; top: Record<string, number> }[];
        complete: boolean;
        next?: string;
      };
    const first = await get("");
    // this instance's own entry sorts into the first page beside the SUMMARY_PAGE others
    expect(first.origins.filter((o) => o.origin !== "hub.example")).toHaveLength(SUMMARY_PAGE);
    expect(first.origins.map((o) => o.origin)).toContain("hub.example");
    expect(first.origins.find((o) => o.origin === "o0000.example")?.top.cache).toBe(10);
    expect(first.complete).toBe(false);
    const second = await get(`?after=${first.next}`);
    expect(second.complete).toBe(true);
    expect(first.origins.length + second.origins.length).toBe(n + 1);
  });
});

describe("a summary's `for`", () => {
  async function hub() {
    const env = instanceEnv("hub.example", await newFedKey());
    const k = await newFedKey();
    const peer = (instance: string, trust: string) =>
      env.DB.prepare("INSERT INTO fed_peers (url, instance, public_key, trust, keys_cursor) VALUES (?, ?, ?, ?, 7)")
        .bind(`https://${instance}`, instance, k.pub, trust)
        .run();
    await peer("known.example", "trusted");
    await peer("blocked.example", "blocked");
    for (const origin of ["known.example", "blocked.example", "stranger.example"])
      await env.DB.prepare(
        "INSERT INTO fed_origin_marks (origin, kind, seq, region, updated_at) VALUES (?, 'find', 42, '', 0)",
      )
        .bind(origin)
        .run();
    const summary = async (q = "") =>
      (await (await serve(env)(new Request(`https://hub.example/federation/sync/summary${q}`))).json()) as {
        origins: { origin: string }[];
        asker?: { held: Record<string, number> };
      };
    return summary;
  }

  it("tells a known, unblocked peer how far this instance holds its records, and leaves it out of the list", async () => {
    const summary = await hub();
    const r = await summary("?for=known.example");
    expect(r.asker).toEqual({ held: { find: 42, key: 7 } });
    expect(r.origins.map((o) => o.origin)).not.toContain("known.example");
    expect((await summary()).origins.map((o) => o.origin)).toContain("known.example");
  });

  it("is ignored for an instance this one does not know or has blocked: the answer is the anonymous one", async () => {
    const summary = await hub();
    const anonymous = await summary();
    expect(anonymous.asker).toBeUndefined();
    for (const asker of ["stranger.example", "blocked.example", "not an instance"])
      expect(await summary(`?for=${encodeURIComponent(asker)}`), asker).toEqual(anonymous);
  });
});
