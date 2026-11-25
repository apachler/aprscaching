// SPDX-License-Identifier: AGPL-3.0-or-later
// The CoT feed's limits: /api/cot and /api/cot/stream count against the read API's per-address budget, and the
// streams one holder (a client address, or an API key) and the whole instance hold open at once are capped.
import { afterEach, describe, expect, it } from "vitest";
import { COT_STREAM_MAX_OPEN } from "@aprscaching/gateway/cot";
import { instanceEnv, serve } from "./helpers/fedpeer.js";

const opened: Response[] = [];
afterEach(async () => {
  for (const r of opened.splice(0)) await r.body?.cancel().catch(() => {});
});

const stream = (s: ReturnType<typeof serve>, ip: string) =>
  s(new Request("https://gw.test/api/cot/stream", { headers: { "x-real-ip": ip } })).then((r) => {
    opened.push(r);
    return r;
  });

describe("the CoT stream", () => {
  it(`is capped at ${COT_STREAM_MAX_OPEN.anonymous} open per address, and a closed one frees its place`, async () => {
    const s = serve(instanceEnv("gw.test", null));
    const first = [];
    for (let i = 0; i < COT_STREAM_MAX_OPEN.anonymous; i++) first.push(await stream(s, "192.0.2.1"));
    expect(first.map((r) => r.status)).toEqual(first.map(() => 200));
    const over = await stream(s, "192.0.2.1");
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("60");
    // another address has its own places
    expect((await stream(s, "192.0.2.2")).status).toBe(200);
    await first[0]!.body!.cancel();
    expect((await stream(s, "192.0.2.1")).status).toBe(200);
  });

  it(`is capped at ${COT_STREAM_MAX_OPEN.total} open over every address`, async () => {
    const s = serve(instanceEnv("gw.test", null));
    for (let i = 0; i < COT_STREAM_MAX_OPEN.total; i++) expect((await stream(s, `198.51.100.${i}`)).status).toBe(200);
    expect((await stream(s, "203.0.113.9")).status).toBe(429);
  });
});

describe("the CoT snapshot and stream", () => {
  it("count against the read API's per-address budget", async () => {
    const s = serve(instanceEnv("gw.test", null, { API_RATE_ANON: "3" }));
    const get = (p: string) => s(new Request(`https://gw.test${p}`, { headers: { "x-real-ip": "192.0.2.7" } }));
    expect((await get("/api/cot")).status).toBe(200);
    expect((await get("/api/cot")).status).toBe(200);
    const r = await get("/api/cot/stream");
    opened.push(r);
    expect(r.status).toBe(200);
    expect((await get("/api/cot")).status).toBe(429);
  });
});
