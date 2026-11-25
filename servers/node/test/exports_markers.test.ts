// SPDX-License-Identifier: AGPL-3.0-or-later
// The GPX, KML and ADIF exports leave this instance, so a per-account withdrawn or former-holder suffix never
// reaches them: every call prints through displayCall, and an archived cache has no single-cache GPX.
import { describe, it, expect } from "vitest";
import { addCache, instanceEnv, serve } from "./helpers/fedpeer.js";

const bbox = "?bbox=15,47,16,48";

describe("exports print calls as readers see them", () => {
  it("an active cache under a former-holder marker prints plain FORMER in GPX, KML and the single GPX", async () => {
    const env = instanceEnv("exp.example", null);
    const fetch = serve(env);
    const id = await addCache(env);
    await env.DB.prepare("UPDATE caches SET owner_call='FORMER#A1B2C3D4E5F6' WHERE id=?").bind(id).run();
    const { code } = (await env.DB.prepare("SELECT code FROM caches WHERE id=?").bind(id).first<{ code: string }>())!;
    for (const path of [`/api/v1/caches.gpx${bbox}`, `/api/v1/caches.kml${bbox}`, `/api/v1/caches/${code}.gpx`]) {
      const res = await fetch(new Request(`https://exp.example${path}`));
      expect(res.status, path).toBe(200);
      const body = await res.text();
      expect(body, path).toContain("FORMER");
      expect(body, path).not.toContain("FORMER#");
    }
  });

  it("an erased owner's archived cache has no single-cache GPX", async () => {
    const env = instanceEnv("exp.example", null);
    const fetch = serve(env);
    const id = await addCache(env);
    await env.DB.prepare("UPDATE caches SET owner_call='WITHDRAWN#0011223344', status='archived' WHERE id=?")
      .bind(id)
      .run();
    const { code } = (await env.DB.prepare("SELECT code FROM caches WHERE id=?").bind(id).first<{ code: string }>())!;
    const res = await fetch(new Request(`https://exp.example/api/v1/caches/${code}.gpx`));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("WITHDRAWN#");
  });

  it("the ADIF export prints a station or owner marker without its suffix", async () => {
    const env = instanceEnv("exp.example", null);
    const fetch = serve(env);
    const a = await addCache(env);
    const b = await addCache(env);
    await env.DB.prepare("UPDATE caches SET owner_call='WITHDRAWN#0011223344', status='archived' WHERE id=?")
      .bind(a)
      .run();
    await env.DB.prepare("UPDATE caches SET station_call='FORMER#A1B2C3D4E5F6' WHERE id=?").bind(b).run();
    for (const id of [a, b])
      await env.DB.prepare(
        "INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, verified) VALUES (?, 'OE8APR', 1700000000, 'found', 1)",
      )
        .bind(id)
        .run();
    const body = await (await fetch(new Request("https://exp.example/api/v1/profile/OE8APR.adif"))).text();
    expect(body.match(/<EOR>/g)).toHaveLength(2);
    expect(body).toContain("WITHDRAWN");
    expect(body).toContain("FORMER");
    expect(body).not.toMatch(/WITHDRAWN#|FORMER#/);
  });
});
