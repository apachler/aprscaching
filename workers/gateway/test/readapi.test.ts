// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { handleApiV1 } from "../src/readapi.js";
import type { Env } from "../src/env.js";

const req = (method: string, rest: string, headers: Record<string, string> = {}) =>
  new Request(`https://api.example/api/v1${rest}`, { method, headers });

describe("public read API /api/v1 (ADR-4a)", () => {
  it("index advertises version, limits and the endpoint catalogue", async () => {
    const res = await handleApiV1(req("GET", ""), {} as Env, "");
    expect(res.status).toBe(200);
    const d = (await res.json()) as any;
    expect(d.version).toBe("v1");
    expect(d.access).toMatch(/read-only/);
    expect(d.rateLimits.anonymous).toBeGreaterThan(0);
    expect(d.rateLimits.with_key).toBeGreaterThan(d.rateLimits.anonymous);
    expect(Array.isArray(d.endpoints)).toBe(true);
  });

  it("is read-only: writes to read paths are 405", async () => {
    const res = await handleApiV1(req("POST", "/caches"), {} as Env, "/caches");
    expect(res.status).toBe(405);
  });

  it("caps bbox size and rejects malformed bbox (before touching the DB)", async () => {
    const big = await handleApiV1(req("GET", "/caches?bbox=-50,-50,50,50"), {} as Env, "/caches");
    expect(big.status).toBe(400);
    expect(((await big.json()) as any).error).toMatch(/too large/);
    const bad = await handleApiV1(req("GET", "/caches?bbox=1,2,3"), {} as Env, "/caches");
    expect(bad.status).toBe(400);
  });

  it("rate-limits per IP and 429s past the anonymous budget", async () => {
    const env = { API_RATE_ANON: "2", API_RATE_WINDOW_SEC: "60" } as unknown as Env;
    const ip = { "x-forwarded-for": "203.0.113.7" };
    // /spots is disabled by default → exercises the gate without needing the DB
    const a = await handleApiV1(req("GET", "/spots", ip), env, "/spots");
    const b = await handleApiV1(req("GET", "/spots", ip), env, "/spots");
    const c = await handleApiV1(req("GET", "/spots", ip), env, "/spots");
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(c.status).toBe(429);
    expect(((await c.json()) as any).limit).toBe(2);
    expect(c.headers.get("retry-after")).toBe("60");
  });

  it("unknown v1 path → 404 with a pointer to the index", async () => {
    const res = await handleApiV1(req("GET", "/nope"), {} as Env, "/nope");
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).see).toBe("/api/v1");
  });
});
