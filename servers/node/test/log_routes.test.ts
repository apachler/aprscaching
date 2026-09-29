// SPDX-License-Identifier: AGPL-3.0-or-later
// A log is posted to its cache: `POST /api/caches/:id/logs`. No route takes the cache id from the body.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup } from "./helpers/authflow.js";

describe("the log route", () => {
  it("logs against the cache named in the path, and no body-addressed route exists", async () => {
    const env = authEnv();
    const me = await emailSignup(env, "logger@example.test", "OE8LOG");
    expect(me.status).toBe(200);
    const created = await call(
      env,
      "POST",
      "/api/caches",
      { title: "Route test", type: "traditional", lat: 47.07, lon: 15.42 },
      { cookie: me.cookie },
    );
    expect(created.status).toBe(201);
    const id = created.data.id ?? created.data.cache?.id;
    for (const path of ["/api/logs", "/api/logs/find"]) {
      const r = await call(env, "POST", path, { cacheId: id, logType: "note", comment: "x" }, { cookie: me.cookie });
      expect(r.status).toBe(404);
    }
    const ok = await call(
      env,
      "POST",
      `/api/caches/${id}/logs`,
      { logType: "note", comment: "x" },
      { cookie: me.cookie },
    );
    expect(ok.status).toBeLessThan(300);
  });
});
