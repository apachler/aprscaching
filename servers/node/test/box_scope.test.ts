// SPDX-License-Identifier: AGPL-3.0-or-later
// What an enrolled box's key may do. It delivers what the box hears and drives the box's own command queue.
// Only once the sysop marks it "Runs this instance's services" does it also run them (the outbox, the packet
// BBS mailbox, FBB forwarding, the NET/ROM node mirror) and queue transmissions; trusting its hearings grants
// none of that. It never acts as the shared secret does: it logs no find, acts for no cache owner and creates
// or imports no cache. A box's frames attest only that box's own trusted sites, and FIRST_PARTY_SITES only the
// shared secret's frames, for a find's Tier A and for an RF callsign verification alike. These drive the real
// gateway over a migrated SQLite with the ingest box's own signing code (apps/ingest gatewayauth.ts).
import { describe, it, expect } from "vitest";
import { createPrivateKey } from "node:crypto";
import type { Env } from "@aprscaching/gateway/env";
import { authEnv, call, emailSignup, ORIGIN } from "./helpers/authflow.js";
import { serve } from "./helpers/fedpeer.js";
import { enrollBody, newBoxKey, signedHeaders, type BoxKey } from "../../../apps/ingest/src/gatewayauth.js";

const OPS = { "x-operator-secret": "test-operator-secret" };
const INGEST = { "x-ingest-secret": "test-ingest-secret" };
const room = { fetch: async () => new Response(null, { status: 204 }) };
const ROOMS = { idFromName: (n: string) => n, get: () => room };
const OWN_SITE = "OE8APR-10";
const LENDER = "OE3LND";
const SITE = "OE3LND-10";
// the position every test packet carries: !4704.41N/01526.27E>
const LAT = 47 + 4.41 / 60;
const LON = 15 + 26.27 / 60;
const now = () => Math.floor(Date.now() / 1000);

function boxKey(box: string): BoxKey {
  const { boxKey: pkcs8, publicKey } = newBoxKey();
  return {
    box,
    key: createPrivateKey({ key: Buffer.from(pkcs8, "base64url"), format: "der", type: "pkcs8" }),
    publicKey,
  };
}

async function enroll(env: Env, box: string, codeBody: Record<string, unknown>) {
  const k = boxKey(box);
  const code = await call(env, "POST", "/api/admin/boxes/codes", codeBody, OPS);
  expect((await call(env, "POST", "/ingest/enroll", enrollBody(k, code.data.code))).status).toBe(201);
  return k;
}

/** An instance with its own site, a lent box enrolled for the lender's call, and a second box with no call. */
async function world() {
  const env = authEnv({ ROOMS, ADMIN_CALLSIGNS: "OE8APR", FIRST_PARTY_SITES: OWN_SITE });
  const lent = await enroll(env, "lent-1", { label: "lent", callsign: LENDER });
  const other = await enroll(env, "other-1", { label: "other" });
  return { env, lent, other };
}

const trustLent = async (env: Env) =>
  expect((await call(env, "POST", "/api/admin/boxes/lent-1/trust", { trusted: true, sites: [SITE] }, OPS)).status).toBe(
    200,
  );

/** One request signed by `k`. */
async function signed(env: Env, k: BoxKey, method: string, path: string, body?: unknown) {
  const url = `${ORIGIN}${path}`;
  const text = body === undefined ? undefined : JSON.stringify(body);
  const res = await serve(env)(
    new Request(url, {
      method,
      headers: { "content-type": "application/json", ...signedHeaders(k, method, url, text) },
      body: text,
    }),
  );
  return { status: res.status, data: await res.json().catch(() => null) };
}

const rfPosition = (src: string, igateCall: string) => ({
  src,
  dst: "APRS",
  path: [],
  payload: "!4704.41N/01526.27E>",
  kind: "position",
  heardVia: "rf",
  port: "kiss-tnc",
  ts: now() - 60,
  igateCall,
});

let seq = 0;
async function cacheHere(env: Env): Promise<number> {
  const r = await env.DB.prepare(
    "INSERT INTO caches (code, owner_call, title, type, lat, lon, created_at, updated_at) VALUES (?, 'OE8OWN', 'Here', 'traditional', ?, ?, ?, ?)",
  )
    .bind(`AC-BS${++seq}`, LAT, LON, now() - 86400, now() - 86400)
    .run();
  return Number(r.meta.last_row_id);
}

/** `logger`'s found log, posted by the instance's own ingest plane; its tier. */
async function findTier(env: Env, logger: string): Promise<string> {
  const id = await cacheHere(env);
  const res = await call(env, "POST", `/api/caches/${id}/logs`, { loggerCall: logger, logType: "found" }, INGEST);
  expect(res.status, JSON.stringify(res.data)).toBeLessThan(300);
  return res.data.tier as string;
}

/** Every station, owner and mailbox action a box key must not take, with the status each returns. */
async function stationActions(env: Env, k: BoxKey): Promise<number[]> {
  const id = await cacheHere(env);
  return [
    (await signed(env, k, "POST", `/api/caches/${id}/logs`, { loggerCall: "DL1FND", logType: "found" })).status,
    (
      await signed(env, k, "POST", "/api/caches", {
        title: "Box",
        type: "traditional",
        lat: 47,
        lon: 15,
        ownerCall: "DL1OWN",
      })
    ).status,
    (await signed(env, k, "PATCH", `/api/caches/${id}`, { ownerCall: "OE8OWN", title: "Renamed" })).status,
    (await signed(env, k, "POST", "/api/import/osm", {})).status,
  ];
}

describe("an enrolled box's key", () => {
  it("delivers what the box hears and drives its own queue, and nothing else", async () => {
    const { env, other } = await world();
    expect((await signed(env, other, "GET", "/ingest/check")).status).toBe(200);
    expect((await signed(env, other, "POST", "/ingest", { packets: [rfPosition("DL1POS", OWN_SITE)] })).status).toBe(
      200,
    );
    expect((await signed(env, other, "GET", "/api/box/other-1/commands")).status).toBe(200);

    for (const s of await stationActions(env, other)) expect([401, 403]).toContain(s);
    // the cache kept its owner and title
    const cache = await env.DB.prepare("SELECT owner_call, title FROM caches ORDER BY id DESC LIMIT 1").first<{
      owner_call: string;
      title: string;
    }>();
    expect(cache).toEqual({ owner_call: "OE8OWN", title: "Here" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM cache_logs").first<{ n: number }>()).toEqual({ n: 0 });

    // an untrusted box runs none of the ingest box's services
    const services: Array<[string, string, unknown]> = [
      ["GET", "/outbox", undefined],
      ["POST", "/outbox/ack", { ids: [1] }],
      ["GET", "/api/bbs/messages?to=DL1FND", undefined],
      ["POST", "/api/bbs/messages", { fromCall: "DL1FND", toCall: "DL2ABC", body: "hi" }],
      ["GET", "/api/bbs/session?call=DL1FND", undefined],
      ["GET", "/api/bbs/partners", undefined],
      ["GET", "/api/bbs/forward/pool?partner=OE1BBB", undefined],
      ["POST", "/api/node/nodes", { dest: "OE1NOD", alias: "NOD", neighbor: "OE1NBR", quality: 200 }],
    ];
    for (const [m, p, b] of services)
      expect([401, 403], `${m} ${p}`).toContain((await signed(env, other, m, p, b)).status);
  });

  it("runs this instance's services only once the sysop allows it, never by trusting its hearings", async () => {
    const { env, lent } = await world();
    await trustLent(env);
    expect((await signed(env, lent, "GET", "/outbox")).status).toBe(401);
    expect((await signed(env, lent, "GET", "/api/bbs/session?call=DL2ABC")).status).toBe(401);
    const tx = { kind: "message", callsign: "OE8VER", payload: { to: "DL1ABC", text: "hi" } };
    await env.DB.prepare(
      "INSERT INTO callsign_verifications (callsign, method, status, verified_at) VALUES ('OE8VER', 'operator', 'verified', ?)",
    )
      .bind(now())
      .run();
    expect((await signed(env, lent, "POST", "/api/box/lent-1/command", tx)).status).toBe(403);

    const services = (on: boolean, headers: Record<string, string>) =>
      call(env, "POST", "/api/admin/boxes/lent-1/services", { services: on }, headers);
    expect((await services(true, {})).status).toBe(403);
    expect((await services(true, INGEST)).status).toBe(403);
    expect((await services(true, OPS)).status).toBe(200);
    const listed = await call(env, "GET", "/api/admin/boxes", undefined, OPS);
    expect(listed.data.boxes.find((b: { box: string }) => b.box === "lent-1").services).toBe(true);

    expect((await signed(env, lent, "POST", "/api/box/lent-1/command", tx)).status).toBe(201);
    expect((await signed(env, lent, "GET", "/outbox")).status).toBe(200);
    expect(
      (await signed(env, lent, "POST", "/api/bbs/messages", { fromCall: "DL1FND", toCall: "DL2ABC", body: "hi" }))
        .status,
    ).toBe(201);
    expect((await signed(env, lent, "GET", "/api/bbs/session?call=DL2ABC")).status).toBe(200);
    expect((await signed(env, lent, "GET", "/api/bbs/partners")).status).toBe(200);
    expect((await signed(env, lent, "GET", "/api/bbs/forward/pool?partner=OE1BBB")).status).toBe(200);
    const node = { dest: "OE1NOD", alias: "NOD", neighbor: "OE1NBR", quality: 200 };
    expect((await signed(env, lent, "POST", "/api/node/nodes", node)).status).toBeLessThan(300);

    for (const s of await stationActions(env, lent)) expect([401, 403]).toContain(s);

    expect((await services(false, OPS)).status).toBe(200);
    expect((await signed(env, lent, "GET", "/outbox")).status).toBe(401);
  });
});

describe("a site trusted through a box", () => {
  const ingestBox = (env: Env, src: string) =>
    env.DB.prepare("SELECT ingest_box FROM positions WHERE callsign = ?")
      .bind(src)
      .first<{ ingest_box: string | null }>();

  it("attests only the frames that box delivers", async () => {
    const { env, lent, other } = await world();
    await trustLent(env);
    // another box, and the shared secret, naming the lent box's site
    await signed(env, other, "POST", "/ingest", { packets: [rfPosition("DL1FND", SITE)] });
    expect(await findTier(env, "DL1FND")).not.toBe("A");
    await call(env, "POST", "/ingest", { packets: [rfPosition("DL2FND", SITE)] }, INGEST);
    expect(await findTier(env, "DL2FND")).not.toBe("A");
    // the lent box itself
    await signed(env, lent, "POST", "/ingest", { packets: [rfPosition("DL3FND", SITE)] });
    expect(await findTier(env, "DL3FND")).toBe("A");
    expect(await ingestBox(env, "DL3FND")).toEqual({ ingest_box: "lent-1" });
    expect(await ingestBox(env, "DL2FND")).toEqual({ ingest_box: null });
    // the instance's own sites count only for the shared secret's frames, never a box's
    await signed(env, other, "POST", "/ingest", { packets: [rfPosition("DL4FND", OWN_SITE)] });
    expect(await findTier(env, "DL4FND")).not.toBe("A");
    await call(env, "POST", "/ingest", { packets: [rfPosition("DL5FND", OWN_SITE)] }, INGEST);
    expect(await findTier(env, "DL5FND")).toBe("A");
    // a box that is the operator's own trusts its site under the box, with one switch
    const own = { trusted: true, sites: [OWN_SITE] };
    expect((await call(env, "POST", "/api/admin/boxes/other-1/trust", own, OPS)).status).toBe(200);
    await signed(env, other, "POST", "/ingest", { packets: [rfPosition("DL6FND", OWN_SITE)] });
    expect(await findTier(env, "DL6FND")).toBe("A");
  });

  it("is listed to the credentials that may claim it", async () => {
    const { env, lent, other } = await world();
    await trustLent(env);
    expect((await call(env, "GET", "/ingest/check", undefined, INGEST)).data.sites).toEqual([OWN_SITE]);
    expect((await signed(env, other, "GET", "/ingest/check")).data.sites).toEqual([]);
    expect((await signed(env, lent, "GET", "/ingest/check")).data.sites).toEqual([SITE]);
  });

  it("completes an RF callsign verification only from that box", async () => {
    const { env, lent, other } = await world();
    await trustLent(env);
    const me = await emailSignup(env, "vfy@example.test", "DL7VFY");
    const s = await call(env, "POST", "/verify/aprs/start", { callsign: "DL7VFY" }, { cookie: me.cookie });
    expect(s.status).toBe(200);
    const verifyMsg = {
      src: "DL7VFY-7",
      dst: "APRS",
      path: ["WIDE1-1"],
      payload: `:${String(s.data.to).padEnd(9)}:${s.data.text}`,
      kind: "message",
      heardVia: "rf",
      igateCall: SITE,
      port: "kiss-tnc",
      ts: now(),
    };
    const verified = async () =>
      (await call(env, "GET", "/verify/aprs/status?callsign=DL7VFY")).data?.verified === true;
    await signed(env, other, "POST", "/ingest", { packets: [verifyMsg] });
    expect(await verified()).toBe(false);
    await call(env, "POST", "/ingest", { packets: [verifyMsg] }, INGEST);
    expect(await verified()).toBe(false);
    await signed(env, lent, "POST", "/ingest", { packets: [{ ...verifyMsg, ts: now() + 1 }] });
    expect(await verified()).toBe(true);
  });
});

describe("the ingest body", () => {
  it("is read through its byte cap, so a chunked body past it is refused", async () => {
    const env = authEnv({ ROOMS });
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent++ < 8) c.enqueue(chunk);
        else c.close();
      },
    });
    const res = await serve(env)(
      new Request(`${ORIGIN}/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", ...INGEST },
        body,
        duplex: "half",
      } as RequestInit),
    );
    expect(res.status).toBe(413);
    // the cap stopped reading part-way: the stream was not drained
    expect(sent).toBeLessThan(8);
    // a body within the cap still lands
    const ok = await call(env, "POST", "/ingest", { packets: [rfPosition("DL1OK", OWN_SITE)] }, INGEST);
    expect(ok.status).toBe(200);
  });
});

describe("FBB forwarding", () => {
  it("carries only mail whose sender's base call is control-verified; the rest stays local", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR" });
    expect((await call(env, "POST", "/api/bbs/forward", { partner: "oe1bbb", route: "OE" }, OPS)).status).toBe(201);
    await env.DB.prepare(
      "INSERT INTO callsign_verifications (callsign, method, status, verified_at) VALUES ('OE8VER', 'operator', 'verified', ?)",
    )
      .bind(now())
      .run();
    const post = (fromCall: string) =>
      call(env, "POST", "/api/bbs/messages", { fromCall, toCall: "OE1XYZ @ OE1BBB.OE.EU", body: "hi" }, INGEST);
    const fromVerified = await post("OE8VER-7");
    const fromUnverified = await post("DL9NOV");
    expect(fromVerified.status).toBe(201);
    expect(fromUnverified.status).toBe(201);

    const pool = await call(env, "GET", "/api/bbs/forward/pool?partner=OE1BBB", undefined, INGEST);
    expect(pool.status).toBe(200);
    const bids = (pool.data.messages as { bid: string }[]).map((m) => m.bid);
    expect(bids).toContain(fromVerified.data.bid);
    expect(bids).not.toContain(fromUnverified.data.bid);
    // the unverified sender's mail is still held here for its addressee
    const local = await env.DB.prepare("SELECT origin FROM bbs_messages WHERE bid = ?")
      .bind(fromUnverified.data.bid)
      .first<{ origin: string }>();
    expect(local?.origin).toBe("local");
  });

  it("carries a federation batch whatever call it is from, to a partner marked for federation only", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR", FED_BBS: "1" });
    await env.DB.prepare(
      "INSERT INTO bbs_messages (bid, type, from_call, to_call, subject, body, posted_at, origin) VALUES ('FEDBID1', 'P', 'ACSFED', 'ACSFED', 's', 'b', ?, 'local')",
    )
      .bind(now())
      .run();
    await env.DB.prepare(
      "INSERT INTO bbs_partners (call, ha, federation) VALUES ('OE1FED-1', 'OE1FED.AUT.EU', 1)",
    ).run();
    const pool = await call(env, "GET", "/api/bbs/forward/pool?partner=OE1FED-1", undefined, INGEST);
    expect(pool.data.messages).toContainEqual(
      expect.objectContaining({ bid: "FEDBID1", type: "P", to: "ACSFED", at: "OE1FED.AUT.EU" }),
    );
    // the catch-all route never carries it
    const fallback = await call(env, "GET", "/api/bbs/forward/pool?partner=IP-FED", undefined, INGEST);
    expect((fallback.data.messages as { bid: string }[]).map((m) => m.bid)).not.toContain("FEDBID1");
  });
});
