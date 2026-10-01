// SPDX-License-Identifier: AGPL-3.0-or-later
// The owner's maintenance pack: every cache the signed-in account owns, wherever it is, each flagged where a
// visit is due; it names the service call a radio log goes to.
import { describe, it, expect } from "vitest";
import type { PackResponse } from "@aprscaching/shared";
import { authEnv, call, emailSignup } from "./helpers/authflow.js";
import type { Env } from "@aprscaching/gateway/env";

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

async function cache(
  env: Env,
  code: string,
  owner: string,
  lat: number,
  lon: number,
  created: number,
  status = "active",
) {
  const r = await env.DB.prepare(
    "INSERT INTO caches (code, owner_call, title, type, lat, lon, status, created_at, updated_at) VALUES (?, ?, ?, 'traditional', ?, ?, ?, ?, ?)",
  )
    .bind(code, owner, `Cache ${code}`, lat, lon, status, created, created)
    .run();
  return Number(r.meta.last_row_id);
}
const log = (env: Env, id: number, type: string, ts: number) =>
  env.DB.prepare("INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, verified) VALUES (?, 'OE1F', ?, ?, 0)")
    .bind(id, ts, type)
    .run();

describe("the owner's maintenance pack", () => {
  it("needs a signed-in owner", async () => {
    const env = authEnv();
    expect((await call(env, "GET", "/api/offline/pack?mine=1")).status).toBe(401);
  });

  it("holds the owner's caches anywhere, flagged where a visit is due, and no one else's", async () => {
    const env = authEnv({ BBS_CALL: "APRSXX" });
    const signup = await emailSignup(env, "owner@example.org", "OE8OWN");
    expect(signup.status).toBe(200);
    const t = now();
    const fine = await cache(env, "AC-FINE", "OE8OWN", 47.1, 15.1, t - 400 * DAY);
    await log(env, fine, "found", t - 10 * DAY);
    const dnfs = await cache(env, "AC-DNF", "OE8OWN-7", -33.9, 151.2, t - 400 * DAY); // an SSID, another continent
    await log(env, dnfs, "found", t - 50 * DAY);
    for (const d of [3, 2, 1]) await log(env, dnfs, "dnf", t - d * DAY);
    await cache(env, "AC-QUIET", "OE8OWN", 48.2, 16.3, t - 400 * DAY);
    await cache(env, "AC-OFF", "OE8OWN", 47.5, 15.5, t - 5 * DAY, "disabled");
    await cache(env, "AC-OTHER", "OE1XYZ", 47.1, 15.1, t - 400 * DAY);
    const r = await call(env, "GET", "/api/offline/pack?mine=1", undefined, { cookie: signup.cookie });
    expect(r.status).toBe(200);
    const pack = r.data as PackResponse;
    expect(pack.serviceCall).toBe("APRSXX");
    const by = Object.fromEntries(pack.caches.map((c) => [c.code, c.attention]));
    expect(Object.keys(by).sort()).toEqual(["AC-DNF", "AC-FINE", "AC-OFF", "AC-QUIET"]);
    expect(by["AC-FINE"]).toEqual([]);
    expect(by["AC-DNF"]).toEqual(["3 did-not-finds in a row"]);
    expect(by["AC-QUIET"]).toEqual(["never found"]);
    expect(by["AC-OFF"]).toEqual(["disabled"]);
  });
});
