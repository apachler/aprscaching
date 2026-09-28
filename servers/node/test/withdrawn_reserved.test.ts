// SPDX-License-Identifier: AGPL-3.0-or-later
// Erasure rewrites an erased person's rows to a withdrawn marker. That marker must never be a call
// anyone can sign in as, a cache owned by it must be uneditable, and two erased people must never
// collide on it.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup, newAuthenticator, passkeyRegister } from "./helpers/authflow.js";
import { addCache } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

const SECRET = { "x-ingest-secret": "test-ingest-secret" };

describe("the withdrawn marker is reserved", () => {
  it("nobody can register WITHDRAWN (email or passkey) or an SSID of it", async () => {
    const env = authEnv();
    expect(
      (await call(env, "POST", "/auth/email/start", { email: "a@example.test", callsign: "WITHDRAWN" })).status,
    ).toBe(409);
    expect(
      (await call(env, "POST", "/auth/email/start", { email: "a@example.test", callsign: "WITHDRAWN-1" })).status,
    ).toBe(409);
    expect((await passkeyRegister(env, "WITHDRAWN", await newAuthenticator())).status).toBe(409);
    expect(
      (await call(env, "POST", "/auth/email/start", { email: "a@example.test", callsign: "WITHDRAWN#1" })).status,
    ).toBe(400);
  });

  it("a signed-in account cannot add or switch to WITHDRAWN", async () => {
    const env = authEnv();
    const s = await emailSignup(env, "a@example.test", "DL1AAA");
    expect((await call(env, "POST", "/auth/callsigns", { callsign: "WITHDRAWN" }, { cookie: s.cookie })).status).toBe(
      409,
    );
    expect((await call(env, "POST", "/auth/callsign", { callsign: "WITHDRAWN" }, { cookie: s.cookie })).status).toBe(
      409,
    );
  });

  it("a cache owned by the withdrawn marker cannot be edited by anyone", async () => {
    const env = authEnv();
    const id = await addCache(env);
    await env.DB.prepare("UPDATE caches SET owner_call='WITHDRAWN' WHERE id=?").bind(id).run();
    const edit = await call(env, "PATCH", `/api/caches/${id}`, { ownerCall: "WITHDRAWN", title: "hijacked" }, SECRET);
    expect(edit.status).toBe(403);
    const row = await env.DB.prepare("SELECT title FROM caches WHERE id=?").bind(id).first<{ title: string }>();
    expect(row!.title).not.toBe("hijacked");
  });
});

async function findAndErase(env: Env, cacheId: number, email: string, cs: string) {
  const s = await emailSignup(env, email, cs);
  expect(s.status).toBe(200);
  const log = await call(env, "POST", `/api/caches/${cacheId}/logs`, { logType: "found" }, { cookie: s.cookie });
  expect(log.status).toBeLessThan(300);
  return call(env, "POST", `/api/account/${cs}/delete`, {}, { cookie: s.cookie });
}

describe("erasure keeps find counts without colliding", () => {
  it("two people who found the same cache can both be erased", async () => {
    const env = authEnv();
    const id = await addCache(env);
    expect((await findAndErase(env, id, "a@example.test", "DL1AAA")).status).toBe(200);
    expect((await findAndErase(env, id, "b@example.test", "DL1BBB")).status).toBe(200);
    const finds = await env.DB.prepare("SELECT logger_call FROM cache_logs WHERE cache_id=? AND log_type='found'")
      .bind(id)
      .all<{ logger_call: string }>();
    expect(finds.results).toHaveLength(2);
    for (const f of finds.results) expect(f.logger_call).toMatch(/^WITHDRAWN#/);
    expect(new Set(finds.results.map((f) => f.logger_call)).size).toBe(2);
  });

  it("an erased owner's cache is archived and uneditable", async () => {
    const env = authEnv();
    const s = await emailSignup(env, "o@example.test", "DL1OWN");
    const created = await call(
      env,
      "POST",
      "/api/caches",
      { title: "mine", type: "traditional", lat: 47, lon: 15 },
      { cookie: s.cookie },
    );
    expect(created.status).toBe(201);
    const id = created.data.cache.id;
    expect((await call(env, "POST", `/api/account/DL1OWN/delete`, {}, { cookie: s.cookie })).status).toBe(200);
    const row = await env.DB.prepare("SELECT owner_call, status FROM caches WHERE id=?")
      .bind(id)
      .first<{ owner_call: string; status: string }>();
    expect(row!.owner_call).toMatch(/^WITHDRAWN#/);
    expect(row!.status).toBe("archived");
    const edit = await call(
      env,
      "PATCH",
      `/api/caches/${id}`,
      { ownerCall: row!.owner_call, status: "active" },
      SECRET,
    );
    expect(edit.status).toBeGreaterThanOrEqual(400);
  });
});
