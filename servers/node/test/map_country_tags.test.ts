// SPDX-License-Identifier: AGPL-3.0-or-later
// The map's cache list carries each cache's country and tags, so the app filters by them.
import { describe, it, expect } from "vitest";
import { authEnv, call, hiderSignup } from "./helpers/authflow.js";

describe("the map's cache list", () => {
  it("carries the owner's country and tags", async () => {
    const env = authEnv();
    const owner = await hiderSignup(env, "tags@example.test", "OE8TAG");
    const made = await call(
      env,
      "POST",
      "/api/caches",
      {
        title: "lake view",
        type: "traditional",
        lat: 47,
        lon: 15,
        country: "OE",
        tags: ["Scenic", "family", "scenic"],
      },
      { cookie: owner.cookie },
    );
    expect(made.status, JSON.stringify(made.data)).toBe(201);
    const list = await call(env, "GET", "/api/caches?bbox=14,46,16,48");
    const c = (list.data.caches as { code: string; country: string | null; tags: string[] }[]).find(
      (x) => x.code === made.data.cache.code,
    );
    expect(c?.country).toBe("OE");
    expect(c?.tags).toEqual(["scenic", "family"]);
  });

  it("takes a country only as a DXCC prefix, and an owner clears it with an empty one", async () => {
    const env = authEnv();
    const owner = await hiderSignup(env, "dxcc@example.test", "OE8DXC");
    const hide = (country: string) =>
      call(
        env,
        "POST",
        "/api/caches",
        { title: "x", type: "traditional", lat: 47, lon: 15, country },
        { cookie: owner.cookie },
      );
    expect((await hide("AT")).status).toBe(400); // an ISO code is not a DXCC prefix
    expect((await hide("Austria")).status).toBe(400);
    const made = await hide("oe");
    expect(made.status).toBe(201);
    expect(made.data.cache.country).toBe("OE");
    const cleared = await call(
      env,
      "PATCH",
      `/api/caches/${made.data.cache.id}`,
      { country: "" },
      { cookie: owner.cookie },
    );
    expect(cleared.status, JSON.stringify(cleared.data)).toBe(200);
    expect(cleared.data.cache.country).toBeNull();
  });
});
