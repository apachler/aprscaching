// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/v1/profile/:call.adif exports a person's finds: every SSID of the base call, as the profile counts
// them, and nobody else's.
import { describe, it, expect } from "vitest";
import { addCache, instanceEnv, serve } from "./helpers/fedpeer.js";

describe("GET /api/v1/profile/:call.adif", () => {
  it("covers the base call and every SSID of it, and no other call or unverified or unlisted find", async () => {
    const env = instanceEnv("adif.example", null);
    const fetch = serve(env);
    const a = await addCache(env);
    const b = await addCache(env);
    const c = await addCache(env);
    const d = await addCache(env);
    const e = await addCache(env);
    await env.DB.prepare("UPDATE caches SET fed_scope='unlisted' WHERE id=?").bind(d).run();
    const log = (cache: number, call: string, type = "found", verified = 1) =>
      env.DB.prepare(
        "INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, verified) VALUES (?, ?, 1700000000, ?, ?)",
      )
        .bind(cache, call, type, verified)
        .run();
    await log(a, "OE8APR");
    await log(b, "OE8APR-7");
    await log(c, "OE8APRX"); // another call that only starts the same
    await log(c, "OE8APR-9", "dnf");
    await log(d, "OE8APR"); // an unlisted cache stays out of public exports
    await log(e, "OE8APR", "found", 0); // so does a find that did not verify

    const res = await fetch(new Request("https://adif.example/api/v1/profile/OE8APR-7.adif"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("OE8APR-finds.adif");
    const body = await res.text();
    expect(body.match(/<EOR>/g)).toHaveLength(2);
  });
});
