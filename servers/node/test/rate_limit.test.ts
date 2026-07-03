// SPDX-License-Identifier: AGPL-3.0-or-later
// SR-SEC-09: the durable rate limiter — one upsert-rolled D1/SQLite row per key, so the budget
// survives Worker isolate fan-out and Node/Bun restarts. Runs against real SQLite via the shim.
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { makeD1 } from "../src/d1.js";
import { migrate } from "../src/migrate.js";
import { rateLimitedDurable, clientIp } from "@aprsweb/gateway/corroborate_privacy";
import type { Env } from "@aprsweb/gateway/env";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");

function freshEnv(extra: Partial<Env> = {}): Env {
  const sqlite = new Database(":memory:");
  migrate(sqlite, MIGRATIONS);
  return { DB: makeD1(sqlite), ...extra } as unknown as Env;
}

describe("SR-SEC-09 — durable fixed-window rate limiting", () => {
  it("allows up to max, then 429s, within one window", async () => {
    const env = freshEnv();
    const t = 1_000_000;
    for (let i = 0; i < 5; i++) expect(await rateLimitedDurable(env, "k1", t, 5, 60_000)).toBe(false);
    expect(await rateLimitedDurable(env, "k1", t + 1000, 5, 60_000)).toBe(true); // 6th call
  });

  it("the window rolls over: a fresh window starts a fresh budget", async () => {
    const env = freshEnv();
    const t = 1_000_000;
    for (let i = 0; i < 6; i++) await rateLimitedDurable(env, "k2", t, 5, 60_000);
    expect(await rateLimitedDurable(env, "k2", t + 61_000, 5, 60_000)).toBe(false); // new window
  });

  it("keys are independent", async () => {
    const env = freshEnv();
    const t = 1_000_000;
    for (let i = 0; i < 6; i++) await rateLimitedDurable(env, "hot", t, 5, 60_000);
    expect(await rateLimitedDurable(env, "cold", t, 5, 60_000)).toBe(false);
  });

  it("the budget is shared across 'isolates' (two limiter callers, one DB)", async () => {
    // the point of SR-SEC-09: two Workers isolates share the D1 row, so the budget cannot be
    // multiplied by fan-out. Simulated by interleaving calls against the same env.
    const env = freshEnv();
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) await rateLimitedDurable(env, "shared", t, 5, 60_000); // "isolate A"
    for (let i = 0; i < 2; i++) await rateLimitedDurable(env, "shared", t, 5, 60_000); // "isolate B"
    expect(await rateLimitedDurable(env, "shared", t, 5, 60_000)).toBe(true); // 6th total
  });
});

describe("SR-SEC-09 — clientIp comes from sources the client cannot choose", () => {
  const reqWith = (h: Record<string, string>) => new Request("http://gw/x", { headers: h });

  it("cf-connecting-ip (edge-stamped) always wins", () => {
    expect(clientIp(reqWith({ "cf-connecting-ip": "203.0.113.1", "x-forwarded-for": "6.6.6.6" }))).toBe("203.0.113.1");
  });

  it("a client-supplied x-forwarded-for is IGNORED unless TRUST_PROXY=1", () => {
    const env = {} as Env;
    expect(clientIp(reqWith({ "x-forwarded-for": "6.6.6.6", "x-real-ip": "192.0.2.7" }), env)).toBe("192.0.2.7");
  });

  it("behind a declared reverse proxy (TRUST_PROXY=1) the forwarded chain's first hop is used", () => {
    const env = { TRUST_PROXY: "1" } as Env;
    expect(clientIp(reqWith({ "x-forwarded-for": "198.51.100.4, 10.0.0.1" }), env)).toBe("198.51.100.4");
  });

  it("falls back to the bridge-stamped socket address, else 'unknown'", () => {
    expect(clientIp(reqWith({ "x-real-ip": "192.0.2.9" }))).toBe("192.0.2.9");
    expect(clientIp(reqWith({}))).toBe("unknown");
  });
});
