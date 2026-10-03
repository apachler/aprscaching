// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /api/v1/profile/:call.adif exports a person's finds: every SSID of the base call, as the profile counts
// them, and nobody else's.
import { describe, it, expect } from "vitest";
import { addCache, instanceEnv, serve } from "./helpers/fedpeer.js";

describe("GET /api/v1/profile/:call.adif", () => {
  it("covers the base call and every SSID of it, and no other call", async () => {
    const env = instanceEnv("adif.example", null);
    const fetch = serve(env);
    const a = await addCache(env);
    const b = await addCache(env);
    const c = await addCache(env);
    const log = (cache: number, call: string, type = "found") =>
      env.DB.prepare(
        "INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, verified) VALUES (?, ?, 1700000000, ?, 1)",
      )
        .bind(cache, call, type)
        .run();
    await log(a, "OE8APR");
    await log(b, "OE8APR-7");
    await log(c, "OE8APRX"); // another call that only starts the same
    await log(c, "OE8APR-9", "dnf");

    const res = await fetch(new Request("https://adif.example/api/v1/profile/OE8APR-7.adif"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("OE8APR-finds.adif");
    const body = await res.text();
    expect(body.match(/<EOR>/g)).toHaveLength(2);
  });
});
