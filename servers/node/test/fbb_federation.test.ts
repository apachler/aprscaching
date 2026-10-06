// SPDX-License-Identifier: AGPL-3.0-or-later
// Federation over FBB on a real instance: off unless FED_BBS is on, carried only to and from the forwarding
// partners the sysop marks for it, as personal mail the forward rules never route, and deduped by its BID.
import { describe, it, expect } from "vitest";
import { encodeFedBbsBatch } from "@aprscaching/shared";
// the app first: it loads the gateway's modules in the order the server does
import { newFedKey, instanceEnv, addCache, serve } from "./helpers/fedpeer.js";
import { signFedRecord } from "@aprscaching/gateway/fedcbor";
import type { Env } from "@aprscaching/gateway/env";

const OPERATOR = { "x-operator-secret": "test-operator-secret" };
const INGEST = { "x-ingest-secret": "test-ingest-secret" };

async function call(env: Env, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await serve(env)(
    new Request(`https://x.example${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}

/** An instance with one cache, a catch-all forward rule to OE1ALL-1, and partner OE1FED-1. */
async function station(extra: Record<string, unknown> = {}) {
  const env = instanceEnv("pub.example", await newFedKey(), { ADMIN_CALLSIGNS: "OE8APR", ...extra });
  await addCache(env, 1000);
  await call(env, "POST", "/api/bbs/partners", { call: "OE1ALL-1", ha: "OE1ALL.AUT.EU" }, OPERATOR);
  await call(env, "POST", "/api/bbs/forward", { partner: "OE1ALL-1", route: "*" }, OPERATOR);
  await call(env, "POST", "/api/bbs/partners", { call: "OE1FED-1", ha: "OE1FED.AUT.EU" }, OPERATOR);
  return env;
}
const pool = async (env: Env, partner: string) =>
  ((await call(env, "GET", `/api/bbs/forward/pool?partner=${partner}`, undefined, INGEST)).data.messages ?? []) as {
    bid: string;
    type: string;
    to: string;
    at: string;
  }[];

describe("off by default", () => {
  it("queues nothing: the enqueue and the relay dispatch are refused", async () => {
    const env = await station();
    const enq = await call(env, "POST", "/federation/bbs/enqueue", {}, OPERATOR);
    expect(enq.status).toBe(409);
    expect((await call(env, "POST", "/federation/relay/spoke.example/dispatch", {}, OPERATOR)).status).toBe(409);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM bbs_messages WHERE to_call = 'ACSFED'").first<{
      n: number;
    }>();
    expect(n?.n).toBe(0);
  });

  it("offers no queued batch to any partner, marked or not", async () => {
    const on = await station({ FED_BBS: "1" });
    await call(on, "POST", "/api/bbs/partners", { call: "OE1FED-1", ha: "OE1FED.AUT.EU", federation: true }, OPERATOR);
    expect((await call(on, "POST", "/federation/bbs/enqueue", {}, OPERATOR)).status).toBe(200);
    // the same database read by an instance with FED_BBS off
    const off = { ...on, FED_BBS: undefined } as unknown as Env;
    expect(await pool(off, "OE1FED-1")).toEqual([]);
    expect(await pool(off, "OE1ALL-1")).toEqual([]);
  });

  it("reports its state on the Setup checklist", async () => {
    const off = await station();
    const item = (env: Env) =>
      call(env, "GET", "/api/admin/setup", undefined, OPERATOR).then((r) =>
        (r.data.items as { key: string; status: string; detail: string }[]).find((i) => i.key === "FED_BBS")!,
      );
    expect(await item(off)).toMatchObject({ status: "ok", detail: expect.stringMatching(/^off/) });
    const on = await station({ FED_BBS: "1" });
    expect(await item(on)).toMatchObject({ status: "warn" });
    await call(on, "POST", "/api/bbs/partners", { call: "OE1FED-1", federation: true }, OPERATOR);
    expect(await item(on)).toMatchObject({ status: "ok", detail: expect.stringMatching(/1 forwarding partner/) });
  });
});

describe("partners only, never flooded", () => {
  it("offers a batch only to the marked partner, as personal mail to ACSFED at its BBS", async () => {
    const env = await station({ FED_BBS: "1" });
    const set = await call(
      env,
      "POST",
      "/api/bbs/partners",
      { call: "OE1FED-1", ha: "OE1FED.AUT.EU", federation: true },
      OPERATOR,
    );
    expect(set.data.partner.federation).toBe(true);
    const enq = await call(env, "POST", "/federation/bbs/enqueue", {}, OPERATOR);
    expect(enq.data).toMatchObject({ ok: true, enqueued: 1 });

    expect(await pool(env, "OE1FED-1")).toEqual([
      expect.objectContaining({ bid: enq.data.bid, type: "P", to: "ACSFED", at: "OE1FED.AUT.EU" }),
    ]);
    // the catch-all rule routes everything else to OE1ALL-1, never the batch
    expect((await pool(env, "OE1ALL-1")).map((m) => m.bid)).not.toContain(enq.data.bid);
    // and it is no bulletin: no listing shows it
    const bulletins = await call(env, "GET", "/api/bbs/bulletins");
    expect(bulletins.data.bulletins).toEqual([]);
  });

  it("keeps the mark when a partner is saved without naming it, and clears it when told", async () => {
    const env = await station({ FED_BBS: "1" });
    await call(env, "POST", "/api/bbs/partners", { call: "OE1FED-1", federation: true }, OPERATOR);
    const resave = await call(env, "POST", "/api/bbs/partners", { call: "OE1FED-1", intervalMin: 60 }, OPERATOR);
    expect(resave.data.partner).toMatchObject({ intervalMin: 60, federation: true });
    const off = await call(env, "POST", "/api/bbs/partners", { call: "OE1FED-1", federation: false }, OPERATOR);
    expect(off.data.partner.federation).toBe(false);
    const list = await call(env, "GET", "/api/bbs/partners", undefined, OPERATOR);
    expect(list.data.federationOverFbb).toBe(true);
    expect(list.data.partners.every((p: { federation: boolean }) => !p.federation)).toBe(true);
  });

  it("an unchanged snapshot queues once", async () => {
    const env = await station({ FED_BBS: "1" });
    const first = await call(env, "POST", "/federation/bbs/enqueue", {}, OPERATOR);
    const second = await call(env, "POST", "/federation/bbs/enqueue", {}, OPERATOR);
    expect(second.data).toMatchObject({ bid: first.data.bid, enqueued: 0, deduped: true });
  });

  it("resumes each feed from its own cursor when the answer's cursors come back as since", async () => {
    const env = await station({ FED_BBS: "1" });
    // a bulletin counts in seconds, a cache in fed_seq values: one shared number cannot resume both
    await env.DB.prepare(
      `INSERT INTO bbs_messages (type, from_call, to_call, subject, body, posted_at, origin)
       VALUES ('B', 'OE8APR', 'ALL', 'Net tonight', 'QRV 20:00', ?, 'local')`,
    )
      .bind(Math.floor(Date.now() / 1000))
      .run();
    const enqueue = (body: unknown) => call(env, "POST", "/federation/bbs/enqueue", body, OPERATOR);

    // a limit of one sends the cache and leaves the bulletin feed where it started
    const first = await enqueue({ types: ["cache", "bulletin"], limit: 1 });
    expect(first.data).toMatchObject({ frames: 1, cursors: { bulletin: { cursor: 0 } } });
    const second = await enqueue({ types: ["cache", "bulletin"], since: first.data.cursors });
    expect(second.data.frames).toBe(1);
    expect(second.data.cursors.cache).toEqual(first.data.cursors.cache);

    // nothing new: the cursors send nothing again
    const idle = await enqueue({ types: ["cache", "bulletin"], since: second.data.cursors });
    expect(idle.data).toMatchObject({ frames: 0, enqueued: 0 });

    // a new cache goes alone
    await addCache(env, 2000);
    const next = await enqueue({ types: ["cache", "bulletin"], since: idle.data.cursors });
    expect(next.data).toMatchObject({ frames: 1, enqueued: 1 });
  });

  it("refuses a person's post to ACSFED", async () => {
    const env = await station({ FED_BBS: "1" });
    const r = await call(
      env,
      "POST",
      "/api/bbs/messages",
      { fromCall: "OE8APR", toCall: "ACSFED", type: "B", body: "hello" },
      INGEST,
    );
    expect(r.status).toBe(400);
  });
});

describe("receiving", () => {
  async function batchFrom() {
    const key = await newFedKey();
    const pub = instanceEnv("pub.example", key);
    const f = await signFedRecord(pub, {
      kind: "key",
      gid: "pub.example:key:1",
      origin: "pub.example",
      v: 1,
      at: Math.floor(Date.now() / 1000),
      signer: "pub.example",
      body: { callsign: "OE8K", publicKey: "PK" },
    });
    return { key, batch: encodeFedBbsBatch([f!]) };
  }
  async function receiver(key: { pub: string }, extra: Record<string, unknown> = {}) {
    const env = instanceEnv("sub.example", await newFedKey(), { ADMIN_CALLSIGNS: "OE1SUB", ...extra });
    await env.DB.prepare(
      "INSERT INTO fed_peers (url, instance, public_key, accept_keys, trust, added_via) VALUES ('https://pub.example', 'pub.example', ?, ?, 'trusted', 'manual')",
    )
      .bind(key.pub, JSON.stringify([{ x: key.pub }]))
      .run();
    await call(env, "POST", "/api/bbs/partners", { call: "OE1FED-1", federation: true }, OPERATOR);
    await call(env, "POST", "/api/bbs/partners", { call: "OE1OTH-1" }, OPERATOR);
    return env;
  }
  const deliver = (env: Env, bid: string, body: string, origin: string) =>
    call(
      env,
      "POST",
      "/api/bbs/forward/inbound",
      { message: { bid, type: "P", from: "OE8APR", to: "ACSFED", body }, origin },
      INGEST,
    );
  const keys = (env: Env) =>
    env.DB.prepare("SELECT COUNT(*) AS n FROM remote_keys")
      .first<{ n: number }>()
      .then((r) => r?.n ?? 0);

  it("applies a batch from the marked partner once, and drops one from any other partner", async () => {
    const { key, batch } = await batchFrom();
    const env = await receiver(key, { FED_BBS: "1" });
    const other = await deliver(env, batch.bid, batch.body, "rf-fbb:OE1OTH-1");
    expect(other.data).toMatchObject({ stored: 0, ignored: "the partner is not marked for federation" });
    expect(await keys(env)).toBe(0);

    const first = await deliver(env, batch.bid, batch.body, "rf-fbb:OE1FED-1");
    expect(first.data).toMatchObject({ stored: 1, federation: { applied: 1 } });
    const again = await deliver(env, batch.bid, batch.body, "rf-fbb:OE1FED-1");
    expect(again.data).toMatchObject({ stored: 0, deduped: true });
    expect(await keys(env)).toBe(1);
    // kept as carrier traffic that expires, never as a bulletin
    const row = await env.DB.prepare("SELECT type, expires_at FROM bbs_messages WHERE bid = ?")
      .bind(batch.bid)
      .first<{ type: string; expires_at: number | null }>();
    expect(row).toMatchObject({ type: "P", expires_at: expect.any(Number) });
  });

  it("applies nothing while FED_BBS is off, even from the marked partner", async () => {
    const { key, batch } = await batchFrom();
    const env = await receiver(key);
    const r = await deliver(env, batch.bid, batch.body, "rf-fbb:OE1FED-1");
    expect(r.data).toMatchObject({ stored: 0, ignored: "federation over FBB is off" });
    expect(await keys(env)).toBe(0);
  });
});
