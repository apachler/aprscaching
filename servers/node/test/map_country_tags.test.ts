// SPDX-License-Identifier: AGPL-3.0-or-later
// The map's cache list carries each cache's country and tags, so the app filters by them.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup } from "./helpers/authflow.js";

describe("the map's cache list", () => {
  it("carries the owner's country and tags", async () => {
    const env = authEnv();
    const owner = await emailSignup(env, "tags@example.test", "OE8TAG");
    const made = await call(
      env,
      "POST",
      "/api/caches",
      {
        title: "lake view",
        type: "traditional",
        lat: 47,
        lon: 15,
        country: "AT",
        tags: ["Scenic", "family", "scenic"],
      },
      { cookie: owner.cookie },
    );
    expect(made.status, JSON.stringify(made.data)).toBe(201);
    const list = await call(env, "GET", "/api/caches?bbox=14,46,16,48");
    const c = (list.data.caches as { code: string; country: string | null; tags: string[] }[]).find(
      (x) => x.code === made.data.cache.code,
    );
    expect(c?.country).toBe("AT");
    expect(c?.tags).toEqual(["scenic", "family"]);
  });
});
