// SPDX-License-Identifier: AGPL-3.0-or-later
// The bounded later attempt at corroboration: a find that missed Tier A only because trusted peers
// could not be reached is asked again — the same question, to those peers only, three times within
// 72 hours. A verified "no", a refusal, or every peer answering ends it; evidence carried over counts
// only while its peer is still trusted; the logger's own track must still allow the presence.
import { describe, it, expect, afterEach, vi } from "vitest";
import { scoreFind, commitFind } from "@aprscaching/gateway/caches";
import { retryCorroborations, RETRY_AFTER_S } from "@aprscaching/gateway/corroborate_retry";
import { newFedKey, instanceEnv, serve, stubFetch, type FedKey, type Serve } from "./helpers/fedpeer.js";
import { authEnv, call, emailSignup } from "./helpers/authflow.js";
import { addCache } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

afterEach(() => vi.unstubAllGlobals());

const LOGGER = "OE8LOG";
const SITE = "OE8XXX";
const LAT = 47.0707;
const LON = 15.4395;
const now = () => Math.floor(Date.now() / 1000);
const P1 = "https://p1.example";
const P2 = "https://p2.example";

/** A peer whose attested site's own TNC heard LOGGER near the cache; `heard: false` hears nobody. */
async function answerer(instance: string, heard = true) {
  const key = await newFedKey();
  const env = instanceEnv(instance, key, { FIRST_PARTY_SITES: SITE });
  if (heard)
    await env.DB.prepare(
      "INSERT INTO positions (callsign, ts, lat, lon, heard_via, igate_call, path, source, transport) VALUES (?, ?, ?, ?, 'rf', ?, 'WIDE1-1', 'aprs', 'tnc')",
    )
      .bind(LOGGER, now() - 600, LAT, LON, SITE)
      .run();
  return { key, env };
}

async function addPeer(env: Env, url: string, instance: string, key: FedKey, trust = "trusted") {
  await env.DB.prepare(
    "INSERT INTO fed_peers (url, instance, public_key, accept_keys, trust, added_via) VALUES (?, ?, ?, ?, ?, 'manual')",
  )
    .bind(url, instance, key.pub, JSON.stringify([{ x: key.pub }]), trust)
    .run();
}

/** A hub with p1 and p2 as trusted peers, and a native cache at the point. */
async function setup(quorum: number) {
  const hub = instanceEnv("hub.example", await newFedKey(), { FED_CORROBORATION_QUORUM: String(quorum) });
  const p1 = await answerer("p1.example");
  const p2 = await answerer("p2.example");
  await addPeer(hub, P1, "p1.example", p1.key);
  await addPeer(hub, P2, "p2.example", p2.key);
  const r = await hub.DB.prepare(
    "INSERT INTO caches (code, owner_call, title, type, lat, lon, created_at, updated_at) VALUES ('AC-RT', 'OE8OWN', 'Retry', 'traditional', ?, ?, 1, 1)",
  )
    .bind(LAT, LON)
    .run();
  const cache = {
    id: Number(r.meta.last_row_id),
    code: "AC-RT",
    title: "Retry",
    type: "traditional",
    lat: LAT,
    lon: LON,
    min_trust: null,
  } as never;
  return { hub, p1, p2, cache };
}

const down: Serve = async () => {
  throw new TypeError("fetch failed");
};
const status =
  (code: number): Serve =>
  async () =>
    new Response("no", { status: code });

async function logFind(hub: Env, cache: never, at = now()) {
  const score = await scoreFind(hub, cache, LOGGER, at);
  const c = await commitFind(hub, cache, LOGGER, at, null, score);
  return { score, logId: c.logId!, at };
}
const retryRow = (hub: Env, logId: number) =>
  hub.DB.prepare("SELECT * FROM corroboration_retries WHERE log_id = ?").bind(logId).first<Record<string, unknown>>();
const logRow = (hub: Env, logId: number) =>
  hub.DB.prepare("SELECT tier, verified, corroborated_by, corroborated_later_at FROM cache_logs WHERE id = ?")
    .bind(logId)
    .first<{ tier: string; verified: number; corroborated_by: string | null; corroborated_later_at: number | null }>();

describe("when a later attempt is queued", () => {
  it("queues one when the only trusted peer could not be reached", async () => {
    const { hub, p2, cache } = await setup(1);
    await hub.DB.prepare("UPDATE fed_peers SET trust='unvetted' WHERE url=?").bind(P2).run();
    stubFetch({ [P1]: down, [P2]: serve(p2.env) });
    const { score, logId, at } = await logFind(hub, cache);
    expect(score.result.tier).not.toBe("A");
    expect(score.retry?.unreachable).toEqual([P1]);
    const row = await retryRow(hub, logId);
    expect(row?.next_at).toBe(at + RETRY_AFTER_S[0]!);
    expect(JSON.parse(String(row?.query)).callsign).toBe(LOGGER);
  });

  it("counts a rate limit and a server error as not reached, a refusal as an answer", async () => {
    const a = await setup(2);
    stubFetch({ [P1]: status(429), [P2]: status(503) });
    expect((await scoreFind(a.hub, a.cache, LOGGER, now())).retry?.unreachable.sort()).toEqual([P1, P2]);
    const b = await setup(2);
    stubFetch({ [P1]: status(401), [P2]: status(403) });
    expect((await scoreFind(b.hub, b.cache, LOGGER, now())).retry).toBeUndefined();
  });

  it("queues none after a trusted peer's verified no", async () => {
    const { hub, cache } = await setup(2);
    const nobody = await answerer("p1.example", false);
    await hub.DB.prepare("UPDATE fed_peers SET public_key=?, accept_keys=? WHERE url=?")
      .bind(nobody.key.pub, JSON.stringify([{ x: nobody.key.pub }]), P1)
      .run();
    stubFetch({ [P1]: serve(nobody.env), [P2]: down });
    const { score, logId } = await logFind(hub, cache);
    expect(score.retry).toBeUndefined();
    expect(await retryRow(hub, logId)).toBeNull();
  });

  it("queues none when every peer answered, or the find reached Tier A", async () => {
    const a = await setup(1);
    stubFetch({ [P1]: serve(a.p1.env), [P2]: serve(a.p2.env) });
    const s = await scoreFind(a.hub, a.cache, LOGGER, now());
    expect(s.result.tier).toBe("A");
    expect(s.retry).toBeUndefined();
  });

  it("never asks unvetted peers again", async () => {
    const { hub, cache } = await setup(1);
    await hub.DB.prepare("UPDATE fed_peers SET trust='unvetted'").run();
    stubFetch({ [P1]: down, [P2]: down });
    expect((await scoreFind(hub, cache, LOGGER, now())).retry).toBeUndefined();
  });
});

describe("the later attempt", () => {
  it("lifts the find to Tier A once the peer answers, and records it as later", async () => {
    const { hub, p1, p2, cache } = await setup(1);
    await hub.DB.prepare("UPDATE fed_peers SET trust='unvetted' WHERE url=?").bind(P2).run();
    stubFetch({ [P1]: down, [P2]: serve(p2.env) });
    const { logId, at } = await logFind(hub, cache);
    expect((await retryCorroborations(hub, at + 60)).asked).toBe(0); // not due yet
    stubFetch({ [P1]: serve(p1.env), [P2]: serve(p2.env) });
    const r = await retryCorroborations(hub, at + RETRY_AFTER_S[0]!);
    expect(r).toMatchObject({ asked: 1, upgraded: 1 });
    const log = await logRow(hub, logId);
    expect(log).toMatchObject({ tier: "A", verified: 1, corroborated_by: "p1.example" });
    expect(log?.corroborated_later_at).toBe(at + RETRY_AFTER_S[0]!);
    expect(await retryRow(hub, logId)).toBeNull();
  });

  it("completes a quorum with evidence already in hand from a peer still trusted", async () => {
    const { hub, p1, p2, cache } = await setup(2);
    stubFetch({ [P1]: serve(p1.env), [P2]: down });
    const { logId, at } = await logFind(hub, cache);
    expect(JSON.parse(String((await retryRow(hub, logId))?.hits))).toHaveLength(1);
    let askedP1 = 0;
    stubFetch({
      [P1]: async (req) => {
        askedP1++;
        return serve(p1.env)(req);
      },
      [P2]: serve(p2.env),
    });
    expect((await retryCorroborations(hub, at + RETRY_AFTER_S[0]!)).upgraded).toBe(1);
    expect(askedP1).toBe(0); // only the peer not reached is asked again
    expect((await logRow(hub, logId))?.tier).toBe("A");
  });

  it("drops evidence from a peer demoted since, and falls short of the quorum", async () => {
    const { hub, p1, p2, cache } = await setup(2);
    stubFetch({ [P1]: serve(p1.env), [P2]: down });
    const { logId, at } = await logFind(hub, cache);
    await hub.DB.prepare("UPDATE fed_peers SET trust='unvetted' WHERE url=?").bind(P1).run();
    stubFetch({ [P1]: serve(p1.env), [P2]: serve(p2.env) });
    const r = await retryCorroborations(hub, at + RETRY_AFTER_S[0]!);
    expect(r.upgraded).toBe(0);
    expect((await logRow(hub, logId))?.tier).not.toBe("A");
    expect(await retryRow(hub, logId)).toBeNull(); // every peer answered: nothing left to wait for
  });

  it("never asks a peer blocked since", async () => {
    const { hub, p1, cache } = await setup(1);
    await hub.DB.prepare("UPDATE fed_peers SET trust='unvetted' WHERE url=?").bind(P2).run();
    stubFetch({ [P1]: down, [P2]: down });
    const { logId, at } = await logFind(hub, cache);
    await hub.DB.prepare("UPDATE fed_peers SET trust='blocked' WHERE url=?").bind(P1).run();
    stubFetch({ [P1]: serve(p1.env) });
    expect((await retryCorroborations(hub, at + RETRY_AFTER_S[0]!)).upgraded).toBe(0);
    expect((await logRow(hub, logId))?.tier).not.toBe("A");
    expect(await retryRow(hub, logId)).toBeNull();
  });

  it("stops at a verified no", async () => {
    const { hub, cache } = await setup(1);
    await hub.DB.prepare("UPDATE fed_peers SET trust='unvetted' WHERE url=?").bind(P2).run();
    stubFetch({ [P1]: down, [P2]: down });
    const { logId, at } = await logFind(hub, cache);
    const nobody = await answerer("p1.example", false);
    await hub.DB.prepare("UPDATE fed_peers SET public_key=?, accept_keys=? WHERE url=?")
      .bind(nobody.key.pub, JSON.stringify([{ x: nobody.key.pub }]), P1)
      .run();
    stubFetch({ [P1]: serve(nobody.env) });
    expect((await retryCorroborations(hub, at + RETRY_AFTER_S[0]!)).dropped).toBe(1);
    expect((await logRow(hub, logId))?.tier).not.toBe("A");
  });

  it("tries three times on the schedule, then gives up", async () => {
    const { hub, cache } = await setup(1);
    await hub.DB.prepare("UPDATE fed_peers SET trust='unvetted' WHERE url=?").bind(P2).run();
    stubFetch({ [P1]: down, [P2]: down });
    const { logId, at } = await logFind(hub, cache);
    for (let i = 0; i < RETRY_AFTER_S.length; i++) {
      const row = await retryRow(hub, logId);
      expect(row?.next_at).toBe(at + RETRY_AFTER_S[i]!);
      expect((await retryCorroborations(hub, at + RETRY_AFTER_S[i]!)).asked).toBe(1);
    }
    expect(await retryRow(hub, logId)).toBeNull();
  });

  it("never reaches back past 72 hours", async () => {
    const { hub, cache } = await setup(1);
    await hub.DB.prepare("UPDATE fed_peers SET trust='unvetted' WHERE url=?").bind(P2).run();
    stubFetch({ [P1]: down, [P2]: down });
    const { logId, at } = await logFind(hub, cache);
    const r = await retryCorroborations(hub, at + 73 * 3600);
    expect(r).toMatchObject({ asked: 0, dropped: 1 });
    expect(await retryRow(hub, logId)).toBeNull();
  });

  it("still needs the logger's own track to allow the presence", async () => {
    const { hub, p1, cache } = await setup(1);
    await hub.DB.prepare("UPDATE fed_peers SET trust='unvetted' WHERE url=?").bind(P2).run();
    stubFetch({ [P1]: down, [P2]: down });
    const { logId, at } = await logFind(hub, cache);
    // a local fix, heard after the find was logged, puts the logger hundreds of km away
    await hub.DB.prepare(
      "INSERT INTO positions (callsign, ts, lat, lon, heard_via, igate_call, source, transport) VALUES (?, ?, 52.52, 13.40, 'aprs_is', 'DB0XX', 'aprs', 'aprs-is')",
    )
      .bind(LOGGER, at - 1100)
      .run();
    stubFetch({ [P1]: serve(p1.env) });
    expect((await retryCorroborations(hub, at + RETRY_AFTER_S[0]!)).upgraded).toBe(0);
    expect((await logRow(hub, logId))?.tier).not.toBe("A");
  });

  it("drops a retry whose log went", async () => {
    const { hub, cache } = await setup(1);
    await hub.DB.prepare("UPDATE fed_peers SET trust='unvetted' WHERE url=?").bind(P2).run();
    stubFetch({ [P1]: down, [P2]: down });
    const { logId, at } = await logFind(hub, cache);
    await hub.DB.prepare("DELETE FROM cache_logs WHERE id = ?").bind(logId).run();
    expect(await retryRow(hub, logId)).toBeNull(); // the foreign key removes it with the log
    expect((await retryCorroborations(hub, at + RETRY_AFTER_S[0]!)).asked).toBe(0);
  });
});

describe("erasure", () => {
  it("removes a pending retry with the person's finds", async () => {
    const env = authEnv();
    const id = await addCache(env);
    const s = await emailSignup(env, "a@example.test", "DL1AAA");
    expect((await call(env, "POST", `/api/caches/${id}/logs`, { logType: "found" }, { cookie: s.cookie })).status).toBe(
      200,
    );
    const log = await env.DB.prepare("SELECT id FROM cache_logs WHERE cache_id = ?").bind(id).first<{ id: number }>();
    await env.DB.prepare(
      "INSERT INTO corroboration_retries (log_id, query, peers, hits, logged_at, next_at) VALUES (?, '{\"callsign\":\"DL1AAA\"}', '[]', '[]', 1, 1)",
    )
      .bind(log!.id)
      .run();
    expect((await call(env, "POST", "/api/account/DL1AAA/delete", {}, { cookie: s.cookie })).status).toBe(200);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM corroboration_retries").first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
