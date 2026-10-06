// SPDX-License-Identifier: AGPL-3.0-or-later
// Cache adoption: a sysop offers a cache to the community (a withdrawn owner's, or an abandoned one after a
// notice period the owner can veto), a signed-in holder of a control-verified call requests it, and the
// sysop approves — or the sysop assigns it straight to a verified holder. Ownership follows the account
// holding the call, every step is audited, and the audit rows are inside export/erase.
import { describe, it, expect, afterEach, vi } from "vitest";
import { authEnv, call, emailSignup, operatorVerify, sysopVerifyCall, type Res } from "./helpers/authflow.js";
import { gid as gidOf, newFedKey, serve, stubFetch } from "./helpers/fedpeer.js";
import { syncAllPeers } from "@aprscaching/gateway/federation_sync";
import { ADOPTION_NOTICE_SEC } from "@aprscaching/gateway/adoption";
import type { Env } from "@aprscaching/gateway/env";

afterEach(() => vi.unstubAllGlobals());

const NOTE = "owner withdrew, cache still in place";

interface World {
  env: Env;
  sysop: Res;
}

async function world(extra: Record<string, unknown> = {}): Promise<World> {
  const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR", ...extra });
  const sysop = await emailSignup(env, "op@example.test", "OE8APR");
  expect(sysop.status).toBe(200);
  await operatorVerify(env, "OE8APR");
  return { env, sysop };
}

/** A signed-in user; `verified` has the sysop verify the call by hand. */
async function user(w: World, cs: string, verified = true): Promise<Res> {
  const s = await emailSignup(w.env, `${cs.toLowerCase()}@example.test`, cs);
  expect(s.status).toBe(200);
  if (verified) {
    const v = await sysopVerifyCall(w.env, w.sysop.cookie, cs);
    expect(v.status).toBe(201);
  }
  return s;
}

/** A cache hidden by `cs`, with one find by someone else, then the owner erases their account. */
async function withdrawnCache(w: World, cs = "DL1OWN"): Promise<number> {
  const owner = await user(w, cs);
  const created = await call(
    w.env,
    "POST",
    "/api/caches",
    { title: "orphan", type: "traditional", lat: 47, lon: 15, description: "under the oak" },
    { cookie: owner.cookie },
  );
  expect(created.status).toBe(201);
  const id = created.data.cache.id as number;
  await w.env.DB.prepare(
    "INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, verified, tier) VALUES (?, 'OE1FND', 1000, 'found', 1, 'B')",
  )
    .bind(id)
    .run();
  expect((await call(w.env, "POST", `/api/account/${cs}/delete`, {}, { cookie: owner.cookie })).status).toBe(200);
  return id;
}

const cacheRow = (env: Env, id: number) =>
  env.DB.prepare("SELECT owner_call, status, updated_at FROM caches WHERE id=?")
    .bind(id)
    .first<{ owner_call: string; status: string; updated_at: number }>();

const offer = (w: World, id: number, note = NOTE) =>
  call(w.env, "POST", "/api/admin/adoptions", { cacheId: id, note }, { cookie: w.sysop.cookie });

const audit = async (env: Env, id: number) =>
  (
    await env.DB.prepare(
      "SELECT action, actor_call, from_call, to_call FROM cache_adoptions WHERE cache_id=? ORDER BY id",
    )
      .bind(id)
      .all<{ action: string; actor_call: string; from_call: string | null; to_call: string | null }>()
  ).results;

describe("the sysop actions are sysop-only", () => {
  it("refuses a signed-in non-sysop and an anonymous caller", async () => {
    const w = await world();
    const id = await withdrawnCache(w);
    const u = await user(w, "DL1USR");
    for (const cookie of [u.cookie, ""]) {
      const h: Record<string, string> = cookie ? { cookie } : {};
      expect((await call(w.env, "GET", "/api/admin/adoptions", undefined, h)).status).toBe(403);
      expect((await call(w.env, "POST", "/api/admin/adoptions", { cacheId: id, note: NOTE }, h)).status).toBe(403);
      expect(
        (await call(w.env, "POST", `/api/admin/adoptions/${id}/assign`, { callsign: "DL1USR", note: NOTE }, h)).status,
      ).toBe(403);
      expect((await call(w.env, "DELETE", `/api/admin/adoptions/${id}`, undefined, h)).status).toBe(403);
    }
    expect((await cacheRow(w.env, id))!.owner_call).toMatch(/^WITHDRAWN#/);
  });
});

describe("offering a withdrawn owner's cache", () => {
  it("lists it for the sysop, requires a note, and shows it publicly without the erasure suffix", async () => {
    const w = await world();
    const id = await withdrawnCache(w);
    const list = await call(w.env, "GET", "/api/admin/adoptions", undefined, { cookie: w.sysop.cookie });
    expect(list.status).toBe(200);
    expect(list.data.withdrawn.map((c: { id: number }) => c.id)).toContain(id);
    expect(JSON.stringify(list.data)).not.toMatch(/WITHDRAWN#/);

    expect((await offer(w, id, "")).status).toBe(400);
    expect((await offer(w, id)).status).toBe(201);
    expect((await offer(w, id)).status).toBe(409);

    const pub = await call(w.env, "GET", "/api/adoptions");
    expect(pub.status).toBe(200);
    const row = pub.data.adoptions.find((a: { cacheId: number }) => a.cacheId === id);
    expect(row).toMatchObject({ ownerCall: "WITHDRAWN", ownerWithdrawn: true, note: NOTE });
    expect(JSON.stringify(pub.data)).not.toMatch(/WITHDRAWN#/);
    const after = await call(w.env, "GET", "/api/admin/adoptions", undefined, { cookie: w.sysop.cookie });
    expect(after.data.withdrawn.map((c: { id: number }) => c.id)).not.toContain(id);
    expect(after.data.offered.map((c: { id: number }) => c.id)).toContain(id);
  });

  it("refuses an imported cache", async () => {
    const w = await world();
    const r = await w.env.DB.prepare(
      "INSERT INTO caches (code, owner_call, title, type, lat, lon, source, created_at, updated_at) VALUES ('GC1','X','t','traditional',47,15,'gpx',1,1)",
    ).run();
    expect((await offer(w, Number(r.meta.last_row_id))).status).toBe(400);
  });
});

describe("community adoption by request", () => {
  it("needs a signed-in holder of a control-verified call", async () => {
    const w = await world();
    const id = await withdrawnCache(w);
    await offer(w, id);
    expect((await call(w.env, "POST", `/api/caches/${id}/adoption`, { inPlace: true })).status).toBe(401);
    const unverified = await user(w, "DL1NEW", false);
    const st = await call(w.env, "GET", `/api/caches/${id}/adoption`, undefined, { cookie: unverified.cookie });
    expect(st.data).toMatchObject({ canRequest: false });
    expect(st.data.reason).toMatch(/verify/i);
    const r = await call(w.env, "POST", `/api/caches/${id}/adoption`, { inPlace: true }, { cookie: unverified.cookie });
    expect(r.status).toBe(403);
  });

  it("refuses a request for a cache that is not offered", async () => {
    const w = await world();
    const id = await withdrawnCache(w);
    const u = await user(w, "DL1ADO");
    const r = await call(w.env, "POST", `/api/caches/${id}/adoption`, { inPlace: true }, { cookie: u.cookie });
    expect(r.status).toBe(409);
  });

  it("approval hands the cache over, keeps its logbook, reactivates it and logs every step", async () => {
    const w = await world();
    const id = await withdrawnCache(w);
    const before = await cacheRow(w.env, id);
    await offer(w, id);
    const u = await user(w, "DL1ADO");
    const st = await call(w.env, "GET", `/api/caches/${id}/adoption`, undefined, { cookie: u.cookie });
    expect(st.data).toMatchObject({ canRequest: true, isOwner: false });
    expect(st.data.offer.note).toBe(NOTE);

    const req = await call(
      w.env,
      "POST",
      `/api/caches/${id}/adoption`,
      { inPlace: true, note: "I live next door" },
      { cookie: u.cookie },
    );
    expect(req.status).toBe(201);
    expect(
      (await call(w.env, "POST", `/api/caches/${id}/adoption`, { inPlace: true }, { cookie: u.cookie })).status,
    ).toBe(409);
    const mine = await call(w.env, "GET", `/api/caches/${id}/adoption`, undefined, { cookie: u.cookie });
    expect(mine.data.request).toMatchObject({ status: "pending", inPlace: true });

    const list = await call(w.env, "GET", "/api/admin/adoptions", undefined, { cookie: w.sysop.cookie });
    const offered = list.data.offered.find((c: { id: number }) => c.id === id);
    expect(offered.requests).toHaveLength(1);
    expect(offered.requests[0]).toMatchObject({ callsign: "DL1ADO", inPlace: true });

    const ok = await call(
      w.env,
      "POST",
      `/api/admin/adoptions/requests/${offered.requests[0].id}/approve`,
      {},
      { cookie: w.sysop.cookie },
    );
    expect(ok.status).toBe(200);
    const after = await cacheRow(w.env, id);
    expect(after).toMatchObject({ owner_call: "DL1ADO", status: "active" });
    expect(after!.updated_at).toBeGreaterThan(before!.updated_at);
    const finds = await w.env.DB.prepare("SELECT COUNT(*) AS n FROM cache_logs WHERE cache_id=?")
      .bind(id)
      .first<{ n: number }>();
    expect(finds!.n).toBe(1);

    expect((await call(w.env, "GET", "/api/adoptions")).data.adoptions).toHaveLength(0);
    expect((await audit(w.env, id)).map((a) => a.action)).toEqual(["offered", "requested", "approved"]);
    const approved = (await audit(w.env, id)).at(-1)!;
    expect(approved).toMatchObject({ actor_call: "OE8APR", to_call: "DL1ADO" });
    expect(approved.from_call).toMatch(/^WITHDRAWN#/);

    // the new owner edits it; the notification reached them
    const edit = await call(w.env, "PATCH", `/api/caches/${id}`, { title: "adopted" }, { cookie: u.cookie });
    expect(edit.status).toBe(200);
    const alert = await w.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM watch_alerts WHERE kind='adoption_approved'",
    ).first<{
      n: number;
    }>();
    expect(alert!.n).toBe(1);
  });

  it("a cache not confirmed in place stays archived until the new owner edits it", async () => {
    const w = await world();
    const id = await withdrawnCache(w);
    await offer(w, id);
    const u = await user(w, "DL1ADO");
    const req = await call(w.env, "POST", `/api/caches/${id}/adoption`, { inPlace: false }, { cookie: u.cookie });
    expect(req.status).toBe(201);
    const ok = await call(
      w.env,
      "POST",
      `/api/admin/adoptions/requests/${req.data.request.id}/approve`,
      {},
      { cookie: w.sysop.cookie },
    );
    expect(ok.status).toBe(200);
    expect(await cacheRow(w.env, id)).toMatchObject({ owner_call: "DL1ADO", status: "archived" });
    const edit = await call(w.env, "PATCH", `/api/caches/${id}`, { status: "active" }, { cookie: u.cookie });
    expect(edit.status).toBe(200);
  });

  it("approving one request declines the others, and a declined requester is told", async () => {
    const w = await world();
    const id = await withdrawnCache(w);
    await offer(w, id);
    const a = await user(w, "DL1AAA");
    const b = await user(w, "DL1BBB");
    const ra = await call(w.env, "POST", `/api/caches/${id}/adoption`, { inPlace: true }, { cookie: a.cookie });
    const rb = await call(w.env, "POST", `/api/caches/${id}/adoption`, { inPlace: true }, { cookie: b.cookie });
    expect(rb.status).toBe(201);
    await call(
      w.env,
      "POST",
      `/api/admin/adoptions/requests/${ra.data.request.id}/approve`,
      {},
      {
        cookie: w.sysop.cookie,
      },
    );
    const other = await w.env.DB.prepare("SELECT status FROM cache_adoption_requests WHERE id=?")
      .bind(rb.data.request.id)
      .first<{ status: string }>();
    expect(other!.status).toBe("declined");
    const stB = await call(w.env, "GET", `/api/caches/${id}/adoption`, undefined, { cookie: b.cookie });
    expect(stB.data.offer).toBeNull();
  });

  it("a requester can cancel, and the sysop can decline", async () => {
    const w = await world();
    const id = await withdrawnCache(w);
    await offer(w, id);
    const u = await user(w, "DL1ADO");
    await call(w.env, "POST", `/api/caches/${id}/adoption`, { inPlace: true }, { cookie: u.cookie });
    expect(
      (await call(w.env, "DELETE", `/api/caches/${id}/adoption/request`, undefined, { cookie: u.cookie })).status,
    ).toBe(200);
    const again = await call(w.env, "POST", `/api/caches/${id}/adoption`, { inPlace: true }, { cookie: u.cookie });
    expect(again.status).toBe(201);
    const no = await call(
      w.env,
      "POST",
      `/api/admin/adoptions/requests/${again.data.request.id}/decline`,
      { note: "please confirm the site first" },
      { cookie: w.sysop.cookie },
    );
    expect(no.status).toBe(200);
    expect((await cacheRow(w.env, id))!.owner_call).toMatch(/^WITHDRAWN#/);
    expect((await audit(w.env, id)).map((a) => a.action)).toEqual([
      "offered",
      "requested",
      "request_cancelled",
      "requested",
      "declined",
    ]);
  });

  it("approval re-checks that the requester still holds a verified call", async () => {
    const w = await world();
    const id = await withdrawnCache(w);
    await offer(w, id);
    const u = await user(w, "DL1ADO");
    const req = await call(w.env, "POST", `/api/caches/${id}/adoption`, { inPlace: true }, { cookie: u.cookie });
    await call(w.env, "DELETE", "/api/admin/verifications/DL1ADO", undefined, { cookie: w.sysop.cookie });
    const ok = await call(
      w.env,
      "POST",
      `/api/admin/adoptions/requests/${req.data.request.id}/approve`,
      {},
      { cookie: w.sysop.cookie },
    );
    expect(ok.status).toBe(409);
    expect((await cacheRow(w.env, id))!.owner_call).toMatch(/^WITHDRAWN#/);
  });

  it("the sysop's withdrawal of an offer cancels its pending requests", async () => {
    const w = await world();
    const id = await withdrawnCache(w);
    await offer(w, id);
    const u = await user(w, "DL1ADO");
    const req = await call(w.env, "POST", `/api/caches/${id}/adoption`, { inPlace: true }, { cookie: u.cookie });
    const del = await call(w.env, "DELETE", `/api/admin/adoptions/${id}`, undefined, { cookie: w.sysop.cookie });
    expect(del.status).toBe(200);
    const r = await w.env.DB.prepare("SELECT status FROM cache_adoption_requests WHERE id=?")
      .bind(req.data.request.id)
      .first<{ status: string }>();
    expect(r!.status).toBe("cancelled");
    expect((await call(w.env, "GET", "/api/adoptions")).data.adoptions).toHaveLength(0);
    expect(
      (await call(w.env, "DELETE", `/api/admin/adoptions/${id}`, undefined, { cookie: w.sysop.cookie })).status,
    ).toBe(404);
  });
});

describe("direct assignment", () => {
  it("needs an account holding a control-verified call", async () => {
    const w = await world();
    const id = await withdrawnCache(w);
    const assign = (callsign: string, note = NOTE) =>
      call(w.env, "POST", `/api/admin/adoptions/${id}/assign`, { callsign, note }, { cookie: w.sysop.cookie });
    expect((await assign("DL9NOB")).status).toBe(404);
    await user(w, "DL1UNV", false);
    expect((await assign("DL1UNV")).status).toBe(403);
    await user(w, "DL1ADO");
    expect((await assign("DL1ADO", "")).status).toBe(400);
    const ok = await assign("DL1ADO");
    expect(ok.status).toBe(200);
    // not confirmed in place by anyone: it stays archived for the new owner to reactivate
    expect(await cacheRow(w.env, id)).toMatchObject({ owner_call: "DL1ADO", status: "archived" });
    expect((await audit(w.env, id)).map((a) => a.action)).toEqual(["assigned"]);
    expect((await assign("DL1ADO")).status).toBe(409);
  });

  it("can reactivate when the sysop says the cache is in place", async () => {
    const w = await world();
    const id = await withdrawnCache(w);
    await user(w, "DL1ADO");
    const ok = await call(
      w.env,
      "POST",
      `/api/admin/adoptions/${id}/assign`,
      { callsign: "DL1ADO", note: NOTE, activate: true },
      { cookie: w.sysop.cookie },
    );
    expect(ok.status).toBe(200);
    expect(await cacheRow(w.env, id)).toMatchObject({ owner_call: "DL1ADO", status: "active" });
  });
});

describe("a cache with an active owner", () => {
  async function ownedCache(w: World) {
    const owner = await user(w, "DL1OWN");
    const created = await call(
      w.env,
      "POST",
      "/api/caches",
      { title: "abandoned", type: "traditional", lat: 47, lon: 15 },
      { cookie: owner.cookie },
    );
    return { owner, id: created.data.cache.id as number };
  }

  it("tells the owner, shows them the offer, and lets them keep the cache", async () => {
    const w = await world();
    const { owner, id } = await ownedCache(w);
    expect((await offer(w, id, "no maintenance for two years")).status).toBe(201);
    const alert = await w.env.DB.prepare("SELECT detail FROM watch_alerts WHERE kind='adoption_offered'").first<{
      detail: string;
    }>();
    expect(alert!.detail).toMatch(/no maintenance/);
    const st = await call(w.env, "GET", `/api/caches/${id}/adoption`, undefined, { cookie: owner.cookie });
    expect(st.data).toMatchObject({ isOwner: true, canRequest: false });
    expect(st.data.offer.noticeEndsAt).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const u = await user(w, "DL1ADO");
    await call(w.env, "POST", `/api/caches/${id}/adoption`, { inPlace: true }, { cookie: u.cookie });
    // someone else cannot decline on the owner's behalf
    expect((await call(w.env, "DELETE", `/api/caches/${id}/adoption`, undefined, { cookie: u.cookie })).status).toBe(
      403,
    );
    const keep = await call(w.env, "DELETE", `/api/caches/${id}/adoption`, undefined, { cookie: owner.cookie });
    expect(keep.status).toBe(200);
    expect((await call(w.env, "GET", "/api/adoptions")).data.adoptions).toHaveLength(0);
    expect((await audit(w.env, id)).map((a) => a.action)).toEqual(["offered", "requested", "owner_declined"]);
  });

  it("cannot change hands before the notice period ends, and can after", async () => {
    const w = await world();
    const { id } = await ownedCache(w);
    await user(w, "DL1ADO");
    const assign = () =>
      call(
        w.env,
        "POST",
        `/api/admin/adoptions/${id}/assign`,
        { callsign: "DL1ADO", note: NOTE },
        { cookie: w.sysop.cookie },
      );
    expect((await assign()).status).toBe(409); // no standing offer
    await offer(w, id);
    expect((await assign()).status).toBe(409); // notice still running
    await w.env.DB.prepare("UPDATE cache_adoption_offers SET offered_at = offered_at - ? WHERE cache_id=?")
      .bind(ADOPTION_NOTICE_SEC + 1, id)
      .run();
    expect((await assign()).status).toBe(200);
    expect(await cacheRow(w.env, id)).toMatchObject({ owner_call: "DL1ADO", status: "active" });
  });
});

describe("ownership follows the account holding the call", () => {
  it("a session whose account no longer holds the owner call cannot edit the cache", async () => {
    const w = await world();
    const id = await withdrawnCache(w);
    const u = await user(w, "DL1ADO");
    await call(
      w.env,
      "POST",
      `/api/admin/adoptions/${id}/assign`,
      { callsign: "DL1ADO", note: NOTE },
      {
        cookie: w.sysop.cookie,
      },
    );
    // the licence moves to another account; the old session still names the call string
    await w.env.DB.prepare("UPDATE account_callsigns SET account_id='acct-other' WHERE callsign='DL1ADO'").run();
    const edit = await call(w.env, "PATCH", `/api/caches/${id}`, { title: "stale session" }, { cookie: u.cookie });
    expect(edit.status).toBe(403);
  });
});

describe("GDPR", () => {
  it("exports the adoption rows of the people involved and anonymises them on erasure", async () => {
    const w = await world();
    const id = await withdrawnCache(w);
    await offer(w, id);
    const u = await user(w, "DL1ADO");
    const req = await call(
      w.env,
      "POST",
      `/api/caches/${id}/adoption`,
      { inPlace: true, note: "my note" },
      { cookie: u.cookie },
    );
    await call(
      w.env,
      "POST",
      `/api/admin/adoptions/requests/${req.data.request.id}/approve`,
      {},
      {
        cookie: w.sysop.cookie,
      },
    );
    const exp = await call(w.env, "POST", "/api/account/DL1ADO/export", {}, { cookie: u.cookie });
    expect(exp.status).toBe(200);
    expect(exp.data.adoptionRequests).toHaveLength(1);
    expect(exp.data.adoptionRequests[0]).toMatchObject({ note: "my note" });
    expect(exp.data.adoptionLog.map((a: { action: string }) => a.action)).toEqual(["requested", "approved"]);

    expect((await call(w.env, "POST", "/api/account/DL1ADO/delete", {}, { cookie: u.cookie })).status).toBe(200);
    const left = await w.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM cache_adoptions WHERE actor_call='DL1ADO' OR to_call='DL1ADO' OR from_call='DL1ADO'",
    ).first<{ n: number }>();
    expect(left!.n).toBe(0);
    const reqs = await w.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM cache_adoption_requests WHERE callsign='DL1ADO'",
    ).first<{
      n: number;
    }>();
    expect(reqs!.n).toBe(0);
    // the trail stays for the sysop, anonymised
    expect((await audit(w.env, id)).map((a) => a.action)).toEqual(["offered", "requested", "approved"]);
    const notes = await w.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM cache_adoptions WHERE cache_id=? AND action IN ('requested','approved') AND note IS NOT NULL",
    )
      .bind(id)
      .first<{ n: number }>();
    expect(notes!.n).toBe(0);
  });
});

describe("federation", () => {
  it("peers mirror the new owner, and scope redaction still holds", async () => {
    const key = await newFedKey();
    const w = await world({ INSTANCE: "a.example", FED_PRIVATE_KEY: key.env });
    const hub = authEnv({ INSTANCE: "hub.example", FED_PRIVATE_KEY: (await newFedKey()).env });
    await hub.DB.prepare(
      "INSERT INTO fed_peers (url, instance, public_key, trust, added_via) VALUES ('https://a.example', 'a.example', ?, 'trusted', 'manual')",
    )
      .bind(key.pub)
      .run();
    stubFetch({ "https://a.example": serve(w.env) });
    const id = await withdrawnCache(w);
    await w.env.DB.prepare("UPDATE caches SET fed_scope='unlisted' WHERE id=?").bind(id).run();
    expect((await syncAllPeers(hub)).errors).toEqual([]);
    const gid = await gidOf(w.env, "cache", id);
    const mirror = () =>
      hub.DB.prepare("SELECT owner_call, status, description FROM remote_caches WHERE global_id=?")
        .bind(gid)
        .first<{ owner_call: string; status: string; description: string | null }>();
    expect(await mirror()).toMatchObject({ owner_call: "WITHDRAWN", status: "archived", description: null });

    await user(w, "DL1ADO");
    const ok = await call(
      w.env,
      "POST",
      `/api/admin/adoptions/${id}/assign`,
      { callsign: "DL1ADO", note: NOTE, activate: true },
      { cookie: w.sysop.cookie },
    );
    expect(ok.status).toBe(200);
    expect((await syncAllPeers(hub)).errors).toEqual([]);
    expect(await mirror()).toMatchObject({ owner_call: "DL1ADO", status: "active", description: null });
  });
});
