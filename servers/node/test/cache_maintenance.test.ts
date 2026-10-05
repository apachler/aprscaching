// SPDX-License-Identifier: AGPL-3.0-or-later
// A finder flags a cache for maintenance on a found or did-not-find log; the owner hears of it and of every
// did-not-find, and clears the flag with a maintenance log. The owner's enabled and disabled logs set the cache's
// status, and a status change in Edit writes the matching log.
import { describe, it, expect } from "vitest";
import type { Env } from "@aprscaching/gateway/env";
import { authEnv, call, emailSignup, type Res } from "./helpers/authflow.js";

async function signup(env: Env, call_: string): Promise<Res> {
  const s = await emailSignup(env, `${call_.toLowerCase()}@example.test`, call_);
  expect(s.status).toBe(200);
  // a hider's call is control-verified
  await env.DB.prepare(
    `INSERT INTO callsign_verifications (callsign, method, status, attempts, created_at, verified_at)
     VALUES (?, 'operator', 'verified', 0, 0, 0) ON CONFLICT(callsign) DO NOTHING`,
  )
    .bind(call_)
    .run();
  return s;
}

async function world() {
  const env = authEnv();
  const owner = await signup(env, "OE8OWN");
  const finder = await signup(env, "DL1FND");
  const created = await call(
    env,
    "POST",
    "/api/caches",
    { title: "Oak", type: "traditional", lat: 47.07, lon: 15.42 },
    { cookie: owner.cookie },
  );
  expect(created.status).toBe(201);
  const id = created.data.cache.id as number;
  const log = (who: Res, body: Record<string, unknown>) =>
    call(env, "POST", `/api/caches/${id}/logs`, body, { cookie: who.cookie });
  const detail = async () => (await call(env, "GET", `/api/caches/${id}`)).data.cache;
  const alerts = async () =>
    (
      await env.DB.prepare("SELECT kind, detail FROM watch_alerts WHERE cache_id = ? ORDER BY id")
        .bind(id)
        .all<{ kind: string; detail: string }>()
    ).results;
  return { env, owner, finder, id, log, detail, alerts };
}

describe("cache maintenance", () => {
  it("a finder's flag shows on the cache and the log, tells the owner, and the owner's maintenance log clears it", async () => {
    const w = await world();
    expect((await w.log(w.finder, { logType: "dnf", needsMaintenance: true })).status).toBe(200);
    const d = await w.detail();
    expect(d).toMatchObject({ needsMaintenance: true, maintenanceReason: "flagged" });
    expect(d.logs[0]).toMatchObject({ logType: "dnf", needsMaintenance: true });
    expect(await w.alerts()).toEqual([{ kind: "cache_maintenance", detail: expect.stringContaining("DL1FND says") }]);

    expect((await w.log(w.owner, { logType: "maintenance", comment: "new logbook" })).status).toBe(200);
    expect(await w.detail()).toMatchObject({ needsMaintenance: false, maintenanceReason: null });
  });

  it("a plain did-not-find tells the owner; a note flags only from someone who tried the cache", async () => {
    const w = await world();
    const early = await w.log(w.finder, { logType: "note", comment: "nice spot", needsMaintenance: true });
    expect(early.status).toBe(409);
    expect((await w.detail()).needsMaintenance).toBe(false);
    await w.log(w.finder, { logType: "dnf" });
    expect(await w.alerts()).toEqual([{ kind: "cache_dnf", detail: "DL1FND did not find " + (await w.detail()).code }]);
    expect((await w.log(w.finder, { logType: "note", comment: "lid cracked", needsMaintenance: true })).status).toBe(
      200,
    );
    expect(await w.detail()).toMatchObject({ needsMaintenance: true, maintenanceReason: "flagged" });
    expect((await w.alerts()).at(-1)).toMatchObject({ kind: "cache_maintenance" });
  });

  it("the detail names the viewer's own attempt, and /api/my/logged lists the settled caches", async () => {
    const w = await world();
    const mine = async (who: Res) =>
      (await call(w.env, "GET", `/api/caches/${w.id}`, undefined, { cookie: who.cookie })).data.cache.yourLog;
    expect(await mine(w.finder)).toBeUndefined();
    await w.log(w.finder, { logType: "dnf" });
    expect(await mine(w.finder)).toBe("dnf");
    const finderLogged = await call(w.env, "GET", "/api/my/logged", undefined, { cookie: w.finder.cookie });
    expect(finderLogged.data).toEqual({ found: [], dnf: [w.id], owned: [] });
    const ownerLogged = await call(w.env, "GET", "/api/my/logged", undefined, { cookie: w.owner.cookie });
    expect(ownerLogged.data).toEqual({ found: [], dnf: [], owned: [w.id] });
    expect((await call(w.env, "GET", "/api/my/logged")).status).toBe(401);
  });

  it("the owner's disabled and enabled logs set the status; only the owner posts them", async () => {
    const w = await world();
    expect((await w.log(w.finder, { logType: "disabled" })).status).toBe(409);
    expect((await w.log(w.owner, { logType: "disabled", comment: "muggled" })).status).toBe(200);
    expect((await w.detail()).status).toBe("disabled");
    expect((await w.log(w.owner, { logType: "enabled" })).status).toBe(200);
    expect((await w.detail()).status).toBe("active");
  });

  it("a status change in Edit writes the matching log", async () => {
    const w = await world();
    const edit = (status: string) =>
      call(w.env, "PATCH", `/api/caches/${w.id}`, { status }, { cookie: w.owner.cookie });
    expect((await edit("disabled")).status).toBe(200);
    expect((await edit("active")).status).toBe(200);
    expect((await edit("archived")).status).toBe(200);
    const logs = (await w.detail()).logs.map((l: { logType: string; comment: string | null }) => [
      l.logType,
      l.comment,
    ]);
    expect(logs).toEqual([
      ["note", "Archived by the owner."],
      ["enabled", null],
      ["disabled", null],
    ]);
  });
});
