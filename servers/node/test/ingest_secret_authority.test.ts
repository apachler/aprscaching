// SPDX-License-Identifier: AGPL-3.0-or-later
// The shared INGEST_SECRET posts packets and nothing more. It never verifies a callsign: whoever holds it can
// type any frame, so a VERIFY it delivers is dropped, and only a box enrolled with its own key, heard at a site
// trusted through that box, proves control of a call. It acts for no box: a box's pairing, polling, acks, queue
// and log take only its own signature, with the operator secret as the operator's override. And it acts as no
// player or cache owner: editing a cache, logging, favourites, watches and ratings take a signed-in session.
import { describe, it, expect } from "vitest";
import type { Env } from "@aprscaching/gateway/env";
import { authEnv, call, emailSignup, hiderSignup } from "./helpers/authflow.js";
import { enrollBox, signedCall, trustedBox } from "./helpers/box.js";

const INGEST = { "x-ingest-secret": "test-ingest-secret" };
const OPS = { "x-operator-secret": "test-operator-secret" };
const room = { fetch: async () => new Response(null, { status: 204 }) };
const ROOMS = { get: () => room };
const SITE = "OE8XXX";
const now = () => Math.floor(Date.now() / 1000);

/** A fresh install: the operator call nobody holds yet, its own site, and a box trusted for that site. */
async function freshInstance() {
  const env = authEnv({ ROOMS, ADMIN_CALLSIGNS: "OE8OPS", FIRST_PARTY_SITES: SITE });
  const box = await trustedBox(env, "shack-rx", [SITE]);
  return { env, box };
}

/** `VERIFY <code>` from `src`, as heard on the TNC at the attested site. */
const verifyFrame = (src: string, start: { to: string; text: string }, ts = now()) => ({
  src,
  dst: "APRS",
  path: ["WIDE1-1", "qAR", SITE],
  payload: `:${String(start.to).padEnd(9)}:${start.text}`,
  kind: "message",
  heardVia: "rf",
  igateCall: SITE,
  port: "kiss-tnc",
  ts,
});

const verified = async (env: Env, cs: string) =>
  (await call(env, "GET", `/verify/aprs/status?callsign=${cs}`)).data?.verified === true;

describe("a VERIFY the shared ingest secret delivers", () => {
  it("does not complete a claim on the operator call, so its holder does not become sysop", async () => {
    const { env } = await freshInstance();
    const claim = await call(env, "POST", "/auth/claims", { callsign: "OE8OPS" });
    expect(claim.status, JSON.stringify(claim.data)).toBe(201);
    const start = await call(env, "POST", "/verify/aprs/start", { callsign: "OE8OPS", claim: claim.data.claim });
    expect(start.status, JSON.stringify(start.data)).toBe(200);
    const forged = await call(env, "POST", "/ingest", { packets: [verifyFrame("OE8OPS-7", start.data)] }, INGEST);
    expect(forged.status).toBe(200);
    const status = await call(env, "POST", "/auth/claims/status", { claim: claim.data.claim });
    expect(status.data?.status).not.toBe("done");
    expect(status.cookie).toBe("");
    expect(await verified(env, "OE8OPS")).toBe(false);
    const who = await call(env, "GET", "/api/admin/whoami", undefined, status.cookie ? { cookie: status.cookie } : {});
    expect(who.data?.sysop).toBe(false);
  });

  it("does not verify a call its holder added, and costs the holder no attempt", async () => {
    const { env } = await freshInstance();
    const me = await emailSignup(env, "dl1abc@example.test", "DL1ABC");
    const start = await call(env, "POST", "/verify/aprs/start", { callsign: "DL1ABC" }, { cookie: me.cookie });
    expect(start.status).toBe(200);
    await call(env, "POST", "/ingest", { packets: [verifyFrame("DL1ABC-7", start.data)] }, INGEST);
    expect(await verified(env, "DL1ABC")).toBe(false);
    const row = await env.DB.prepare("SELECT attempts FROM callsign_verifications WHERE callsign = 'DL1ABC'").first<{
      attempts: number;
    }>();
    expect(row?.attempts).toBe(0);
  });
});

describe("a VERIFY an enrolled box delivers with its own key", () => {
  it("verifies the call when heard at a site trusted through that box", async () => {
    const { env, box } = await freshInstance();
    const me = await emailSignup(env, "dl1abc@example.test", "DL1ABC");
    const start = await call(env, "POST", "/verify/aprs/start", { callsign: "DL1ABC" }, { cookie: me.cookie });
    const r = await signedCall(env, box, "POST", "/ingest", { packets: [verifyFrame("DL1ABC-7", start.data)] });
    expect(r.status).toBe(200);
    expect(await verified(env, "DL1ABC")).toBe(true);
  });

  it("completes a claim on the operator call for whoever transmits from it", async () => {
    const { env, box } = await freshInstance();
    const claim = await call(env, "POST", "/auth/claims", { callsign: "OE8OPS" });
    const start = await call(env, "POST", "/verify/aprs/start", { callsign: "OE8OPS", claim: claim.data.claim });
    await signedCall(env, box, "POST", "/ingest", { packets: [verifyFrame("OE8OPS-7", start.data)] });
    const status = await call(env, "POST", "/auth/claims/status", { claim: claim.data.claim });
    expect(status.data?.status).toBe("done");
  });
});

describe("where a VERIFY can be heard", () => {
  it("is only the sites trusted through an enrolled box, never FIRST_PARTY_SITES alone", async () => {
    const env = authEnv({ ROOMS, FIRST_PARTY_SITES: SITE });
    expect((await call(env, "GET", "/verify/methods")).data).toMatchObject({
      methods: { rf_heard: false },
      rfSites: [],
    });
    const me = await emailSignup(env, "dl1abc@example.test", "DL1ABC");
    const start = await call(env, "POST", "/verify/aprs/start", { callsign: "DL1ABC" }, { cookie: me.cookie });
    expect(start.data?.reason).toBe("no_receiving_site");
    await trustedBox(env, "shack-rx", ["OE8XXX-10"]);
    expect((await call(env, "GET", "/verify/methods")).data).toMatchObject({
      methods: { rf_heard: true },
      rfSites: ["OE8XXX-10"],
    });
  });
});

/** Every /api/box/:id endpoint the box or its operator calls. */
const endpoints = (id: string) =>
  [
    ["POST", `/api/box/${id}/pair`, {}],
    ["GET", `/api/box/${id}/commands`, undefined],
    ["POST", `/api/box/${id}/commands/ack`, { id: 1, status: "done" }],
    ["POST", `/api/box/${id}/command`, { kind: "status" }],
    ["GET", `/api/box/${id}/log`, undefined],
  ] as const;

describe("the shared secret acts for no box", () => {
  it.each([
    ["enrolled with its own key", true],
    ["with no key of its own", false],
  ])("a box %s is not paired, polled, acked, queued or read by it", async (_, keyed) => {
    const env = authEnv({ ROOMS });
    if (keyed) await enrollBox(env, "pi-home");
    for (const [m, p, b] of endpoints("pi-home")) {
      const r = await call(env, m, p, b, INGEST);
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.data?.error).toMatch(/enroll the box with its own key/);
    }
    expect(await env.DB.prepare("SELECT 1 AS x FROM box_pairings WHERE box_id = 'pi-home'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 AS x FROM box_commands WHERE box_id = 'pi-home'").first()).toBeNull();
  });

  it("nor re-pairs another account's box, or reads its log", async () => {
    const env = authEnv({ ROOMS });
    const k = await enrollBox(env, "pi-home");
    const owner = await emailSignup(env, "owner@example.test", "DL1OWN");
    const pair = await signedCall(env, k, "POST", "/api/box/pi-home/pair", {});
    expect(
      (await call(env, "POST", "/api/box/pi-home/claim", { code: pair.data.code }, { cookie: owner.cookie })).status,
    ).toBe(200);
    await call(env, "POST", "/api/box/pi-home/command", { kind: "status" }, { cookie: owner.cookie });
    const intruder = await emailSignup(env, "intruder@example.test", "DL9BAD");
    expect((await call(env, "POST", "/api/box/pi-home/pair", {}, { ...INGEST, cookie: intruder.cookie })).status).toBe(
      403,
    );
    expect((await call(env, "GET", "/api/box/pi-home/log", undefined, INGEST)).status).toBe(403);
    expect((await call(env, "GET", "/api/box/pi-home/log", undefined, { cookie: intruder.cookie })).status).toBe(403);
    expect(
      (await call(env, "GET", "/api/box/pi-home/log", undefined, { cookie: owner.cookie })).data?.commands,
    ).toHaveLength(1);
  });
});

describe("a box enrolled with its own key", () => {
  it("takes its own signature, and the operator secret as the override", async () => {
    const env = authEnv({ ROOMS });
    const k = await enrollBox(env, "keyed-1");
    for (const [m, p, b] of endpoints("keyed-1")) {
      expect((await signedCall(env, k, m, p, b)).status, `signed ${m} ${p}`).toBeLessThan(300);
      expect((await call(env, m, p, b, OPS)).status, `operator ${m} ${p}`).toBeLessThan(300);
    }
  });

  it("does not sign for another box", async () => {
    const env = authEnv({ ROOMS });
    const k = await enrollBox(env, "keyed-1");
    await enrollBox(env, "keyed-2");
    const r = await signedCall(env, k, "POST", "/api/box/keyed-2/pair", {});
    expect(r.status).toBe(403);
  });
});

describe("the shared secret acts as no player or cache owner", () => {
  /** A cache DL1OWN hid, and a player DL1ABC who has found nothing yet. */
  async function owned() {
    const env = authEnv({ ROOMS });
    const owner = await hiderSignup(env, "owner@example.test", "DL1OWN");
    const c = await call(
      env,
      "POST",
      "/api/caches",
      { title: "oak", type: "traditional", lat: 47, lon: 15 },
      { cookie: owner.cookie },
    );
    expect(c.status, JSON.stringify(c.data)).toBe(201);
    await emailSignup(env, "dl1abc@example.test", "DL1ABC");
    return { env, id: c.data.cache.id as number };
  }
  const title = async (env: Env, id: number) =>
    (await env.DB.prepare("SELECT title FROM caches WHERE id = ?").bind(id).first<{ title: string }>())?.title;
  const rows = async (env: Env, table: string, id: number) =>
    (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE cache_id = ?`).bind(id).first<{ n: number }>())?.n;

  it.each(["PATCH", "PUT"])("does not %s a cache as its owner", async (m) => {
    const { env, id } = await owned();
    const r = await call(env, m, `/api/caches/${id}`, { ownerCall: "DL1OWN", title: "pwned" }, INGEST);
    expect(r.status).toBe(403);
    expect(await title(env, id)).toBe("oak");
  });

  it("does not hide a cache, or set its stages, under a named owner", async () => {
    const { env, id } = await owned();
    const hide = await call(env, "POST", "/api/caches", { title: "x", lat: 47, lon: 15, ownerCall: "DL1OWN" }, INGEST);
    expect(hide.status).toBe(401);
    const stages = await call(env, "POST", `/api/caches/${id}/stages`, { ownerCall: "DL1OWN", stages: [] }, INGEST);
    expect(stages.status).toBe(403);
  });

  it("does not log a find, favourite, watch or rate in a named player's call", async () => {
    const { env, id } = await owned();
    const as = { callsign: "DL1ABC" };
    expect(
      (await call(env, "POST", `/api/caches/${id}/logs`, { loggerCall: "DL1ABC", logType: "found" }, INGEST)).status,
    ).toBe(401);
    expect((await call(env, "POST", `/api/caches/${id}/favorite`, { ...as, on: true }, INGEST)).status).toBe(401);
    expect((await call(env, "POST", `/api/caches/${id}/watch`, { ...as, on: true }, INGEST)).status).toBe(401);
    expect((await call(env, "POST", `/api/caches/${id}/rate`, { ...as, stars: 1 }, INGEST)).status).toBe(401);
    for (const t of ["cache_logs", "favorites", "watches", "cache_ratings"]) expect(await rows(env, t, id), t).toBe(0);
  });

  it("reads no player's favourite or rating by a named call", async () => {
    const { env, id } = await owned();
    const me = await emailSignup(env, "dl2fav@example.test", "DL2FAV");
    await call(env, "POST", `/api/caches/${id}/favorite`, { on: true }, { cookie: me.cookie });
    const named = await call(env, "GET", `/api/caches/${id}?callsign=DL2FAV`, undefined, INGEST);
    expect(named.data?.cache?.favorites).toBe(1);
    expect(named.data?.cache?.favorited).toBe(false);
  });
});
