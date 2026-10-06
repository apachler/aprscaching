// SPDX-License-Identifier: AGPL-3.0-or-later
// A find is confirmed by a firewalled instance's receivers through its hub's relay. Three real instances
// behind a stubbed fetch: the asker where the find is logged, the hub, and a spoke nobody can dial that
// pushes to the hub and collects its relay queries. The question and the answer are the same signed frames
// as the direct exchange; the hub only carries them.
import { describe, it, expect, afterEach, vi } from "vitest";
import { scoreFind, commitFind } from "@aprscaching/gateway/caches";
import { askPeers } from "@aprscaching/gateway/corroborate";
import { collectRelayedCorroborations, retryCorroborations } from "@aprscaching/gateway/corroborate_retry";
import { pushToHub } from "@aprscaching/gateway/fedpush";
import { relayPoll } from "@aprscaching/gateway/relay";
import { addCache, newFedKey, instanceEnv, serve, stubFetch, type FedKey } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

afterEach(() => vi.unstubAllGlobals());

const LOGGER = "OE8LOG";
const SITE = "OE8XXX";
const HUB_SITE = "OE8HHH";
const LAT = 47.0707;
const LON = 15.4395;
const now = () => Math.floor(Date.now() / 1000);
const HUB = "https://hub.example";
const RELAY = "relay-secret";
const SUBMIT = "submit-secret";

async function addPeer(env: Env, url: string, instance: string, key: FedKey, trust = "trusted") {
  await env.DB.prepare(
    "INSERT INTO fed_peers (url, instance, public_key, accept_keys, trust, added_via) VALUES (?, ?, ?, ?, ?, 'manual')",
  )
    .bind(url, instance, key.pub, JSON.stringify([{ x: key.pub }]), trust)
    .run();
}

async function addNativeCache(env: Env) {
  const r = await env.DB.prepare(
    "INSERT INTO caches (code, owner_call, title, type, lat, lon, created_at, updated_at) VALUES ('AC-RL', 'OE8OWN', 'Relay', 'traditional', ?, ?, 1, 1)",
  )
    .bind(LAT, LON)
    .run();
  return {
    id: Number(r.meta.last_row_id),
    code: "AC-RL",
    title: "Relay",
    type: "traditional",
    lat: LAT,
    lon: LON,
    min_trust: null,
  } as never;
}

/**
 * The asker, the hub and the firewalled spoke. The spoke's own TNC (an attested site) heard LOGGER near the
 * cache, and it has pushed to the hub once, so the hub holds it as a push spoke; the asker trusts the spoke
 * at an address nobody can dial and knows the hub; the hub knows the asker.
 */
async function network(opts: { spokeHeard?: boolean; hubHeard?: boolean; askerHub?: boolean; quorum?: number } = {}) {
  const askerKey = await newFedKey();
  const hubKey = await newFedKey();
  const spokeKey = await newFedKey();
  const hub = instanceEnv("hub.example", hubKey, {
    FED_RELAY_SECRET: RELAY,
    FED_SUBMIT_SECRET: SUBMIT,
    FIRST_PARTY_SITES: HUB_SITE,
  });
  const spoke = instanceEnv("s.example", spokeKey, {
    FED_HUB_URL: HUB,
    FED_RELAY_SECRET: RELAY,
    FED_SUBMIT_SECRET: SUBMIT,
    FIRST_PARTY_SITES: SITE,
  });
  const asker = instanceEnv("a.example", askerKey, {
    FED_CORROBORATION_QUORUM: String(opts.quorum ?? 1),
    ...(opts.askerHub !== false ? { FED_HUB_URL: HUB } : {}),
  });
  const heard = (env: Env, site: string) =>
    env.DB.prepare(
      "INSERT INTO positions (callsign, ts, lat, lon, heard_via, igate_call, path, source, transport) VALUES (?, ?, ?, ?, 'rf', ?, 'WIDE1-1', 'aprs', 'tnc')",
    )
      .bind(LOGGER, now() - 600, LAT, LON, site)
      .run();
  if (opts.spokeHeard !== false) await heard(spoke, SITE);
  if (opts.hubHeard) await heard(hub, HUB_SITE);
  stubFetch({ [HUB]: serve(hub) });
  await addCache(spoke);
  await pushToHub(spoke); // registers the spoke on the hub as a push spoke
  await addPeer(hub, "https://a.example", "a.example", askerKey);
  await addPeer(asker, "https://s.example", "s.example", spokeKey); // a URL nobody can reach
  if (opts.askerHub === false) await addPeer(asker, HUB, "hub.example", hubKey);
  return { asker, hub, spoke, cache: await addNativeCache(asker), keys: { askerKey, hubKey, spokeKey } };
}

async function logFind(env: Env, cache: never) {
  const at = now();
  const score = await scoreFind(env, cache, LOGGER, at);
  const c = await commitFind(env, cache, LOGGER, at, null, score);
  return { score, logId: c.logId!, at };
}
const logRow = (env: Env, id: number) =>
  env.DB.prepare("SELECT tier, corroborated_by, corroborated_later_at FROM cache_logs WHERE id = ?")
    .bind(id)
    .first<{ tier: string; corroborated_by: string | null; corroborated_later_at: number | null }>();
const retryRow = (env: Env, id: number) =>
  env.DB.prepare("SELECT peers, relayed FROM corroboration_retries WHERE log_id = ?")
    .bind(id)
    .first<{ peers: string; relayed: string }>();

describe("a find confirmed through a hub's relay", () => {
  it("lifts a find on the asker once the firewalled spoke's receiver answers through the hub", async () => {
    const t = await network();
    const { score, logId } = await logFind(t.asker, t.cache);
    expect(score.result.tier).not.toBe("A");
    expect(score.retry?.unreachable).toEqual([]); // the spoke is asked, not counted as unreachable
    expect(score.retry?.relayed).toMatchObject([{ instance: "s.example", hub: HUB }]);
    expect((await collectRelayedCorroborations(t.asker)).upgraded).toBe(0); // the spoke has not polled yet

    await relayPoll(t.spoke); // the spoke collects the question on its own outbound poll and answers it
    const r = await collectRelayedCorroborations(t.asker);
    expect(r).toMatchObject({ collected: 1, upgraded: 1 });
    const log = await logRow(t.asker, logId);
    expect(log).toMatchObject({ tier: "A", corroborated_by: "s.example" });
    expect(log?.corroborated_later_at).not.toBeNull();
    expect(await retryRow(t.asker, logId)).toBeNull();
  });

  it("reaches a quorum of the hub, asked directly, and the spoke, through the hub", async () => {
    // no FED_HUB_URL on the asker: the hub is one of its trusted peers, and relays for the spoke
    const t = await network({ askerHub: false, hubHeard: true, quorum: 2 });
    const { score, logId } = await logFind(t.asker, t.cache);
    expect(score.result.tier).not.toBe("A"); // one voice so far
    expect(score.retry?.hits.map((h) => h.ev.instance)).toEqual(["hub.example"]);
    expect(score.retry?.relayed).toMatchObject([{ hub: HUB }]);
    await relayPoll(t.spoke);
    expect((await collectRelayedCorroborations(t.asker)).upgraded).toBe(1);
    expect((await logRow(t.asker, logId))?.tier).toBe("A");
  });

  it("counts one operator once, whichever path its answers took", async () => {
    const t = await network({ askerHub: false, hubHeard: true, quorum: 2 });
    await t.asker.DB.prepare("UPDATE fed_peers SET operator_call = 'OE8OPR'").run();
    const { logId } = await logFind(t.asker, t.cache);
    await relayPoll(t.spoke);
    expect((await collectRelayedCorroborations(t.asker)).upgraded).toBe(0);
    expect((await logRow(t.asker, logId))?.tier).not.toBe("A");
  });

  it("lifts a find on the hub itself through its own relay queue", async () => {
    const t = await network();
    await t.hub.DB.prepare("UPDATE fed_peers SET trust = 'trusted' WHERE url = 'submit:s.example'").run();
    const hub = { ...t.hub, FED_CORROBORATION_QUORUM: "1" } as Env;
    const cache = await addNativeCache(hub);
    const { score, logId } = await logFind(hub, cache);
    expect(score.retry?.relayed).toMatchObject([{ instance: "s.example", hub: "" }]);
    await relayPoll(t.spoke);
    expect((await collectRelayedCorroborations(hub)).upgraded).toBe(1);
    expect((await logRow(hub, logId))?.corroborated_by).toBe("s.example");
  });

  it("no longer counts a push-only spoke as unreachable", async () => {
    const t = await network();
    await t.hub.DB.prepare("UPDATE fed_peers SET trust = 'trusted' WHERE url = 'submit:s.example'").run();
    const asked = await askPeers(t.hub, {
      callsign: LOGGER,
      lat: LAT,
      lon: LON,
      radiusM: 150,
      since: now() - 1800,
      until: now(),
    });
    expect(asked.unreachable).not.toContain("submit:s.example");
    expect(asked.relayed.map((a) => a.instance)).toEqual(["s.example"]);
  });

  it("ends the attempts on the spoke's verified no", async () => {
    const t = await network({ spokeHeard: false });
    const { logId } = await logFind(t.asker, t.cache);
    await relayPoll(t.spoke);
    expect((await collectRelayedCorroborations(t.asker)).dropped).toBe(1);
    expect((await logRow(t.asker, logId))?.tier).not.toBe("A");
    expect(await retryRow(t.asker, logId)).toBeNull();
  });

  it("returns an unanswered question to the next attempt after an hour", async () => {
    const t = await network();
    const { logId, at } = await logFind(t.asker, t.cache);
    const r = await collectRelayedCorroborations(t.asker, at + 3601);
    expect(r.collected).toBe(1);
    const row = await retryRow(t.asker, logId);
    expect(JSON.parse(String(row?.relayed))).toEqual([]);
    expect(JSON.parse(String(row?.peers))).toEqual(["https://s.example"]);
    // the next attempt asks through the hub again, and that answer lifts the find
    await retryCorroborations(t.asker, at + 3601);
    expect(JSON.parse(String((await retryRow(t.asker, logId))?.relayed))).toHaveLength(1);
    await relayPoll(t.spoke);
    expect((await collectRelayedCorroborations(t.asker)).upgraded).toBe(1);
  });

  it("keeps a relayed answer out of the quorum once the spoke is no longer trusted", async () => {
    const t = await network();
    const { logId } = await logFind(t.asker, t.cache);
    await relayPoll(t.spoke);
    await t.asker.DB.prepare("UPDATE fed_peers SET trust = 'unvetted' WHERE url = 'https://s.example'").run();
    expect((await collectRelayedCorroborations(t.asker)).upgraded).toBe(0);
    expect((await logRow(t.asker, logId))?.tier).not.toBe("A");
  });
});

describe("the hub forwards only what it should", () => {
  const question = async (signer: Env, origin: string, target: string) => {
    const { signFedRecord } = await import("@aprscaching/gateway/fedcbor");
    const at = now();
    return signFedRecord(signer, {
      kind: "corroborationQuery",
      gid: `${origin}:corroborationQuery:n1`,
      origin,
      v: at,
      at,
      signer: origin,
      body: {
        callsign: LOGGER,
        latE7: 470707000,
        lonE7: 154395000,
        radiusM: 150,
        since: at - 1800,
        until: at,
        nonce: "n1",
        target,
      },
    });
  };
  const post = (hub: Env, body: Uint8Array) =>
    serve(hub)(
      new Request(`${HUB}/federation/corroborate`, {
        method: "POST",
        headers: { "content-type": "application/cbor", "x-real-ip": "198.51.100.7" },
        body: body as BodyInit,
      }),
    );

  it("refuses an asker it does not know, and a target that is not its push spoke", async () => {
    const t = await network();
    const stranger = instanceEnv("x.example", await newFedKey());
    expect((await post(t.hub, (await question(stranger, "x.example", "s.example"))!)).status).toBe(401);
    expect((await post(t.hub, (await question(t.asker, "a.example", "other.example"))!)).status).toBe(404);
    const ok = await post(t.hub, (await question(t.asker, "a.example", "s.example"))!);
    expect(ok.status).toBe(202);
  });

  it("forwards nothing while its relay is off", async () => {
    const t = await network();
    const hub = { ...t.hub, FED_RELAY_SECRET: undefined } as unknown as Env;
    expect((await post(hub, (await question(t.asker, "a.example", "s.example"))!)).status).toBe(404);
  });

  it("lets only the asking instance read the answer, by its signature and its ticket", async () => {
    const t = await network();
    const res = await post(t.hub, (await question(t.asker, "a.example", "s.example"))!);
    const { id, ticket } = (await res.json()) as { id: number; ticket: string };
    const read = (headers: Record<string, string>) =>
      serve(t.hub)(new Request(`${HUB}/federation/relay/result/${id}`, { headers }));
    // the relay secret and the ticket are not enough: the read must be signed by the asker
    expect((await read({ "x-relay-secret": RELAY, "x-relay-ticket": ticket })).status).toBe(401);
    const { signRelayRequest } = await import("@aprscaching/gateway/relay");
    const signed = await signRelayRequest(t.asker, "GET", `${HUB}/federation/relay/result/${id}`);
    expect((await read({ ...signed!, "x-relay-ticket": ticket })).status).toBe(200);
    expect((await read({ ...signed! })).status).toBe(403);
  });
});
