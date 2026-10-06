// SPDX-License-Identifier: AGPL-3.0-or-later
// Who a box transmits for, and what follows a call when it changes hands. Over the real gateway and a migrated
// SQLite: a box the sysop enrols for another ham is that ham's; a revoked box has no owner; the shared secret
// cannot borrow an enrolled box's owner; releasing or erasing a call takes its box trust and boxes with it; a
// suspended call or box owner transmits nothing and attests nothing; a revoked verification leaves nothing
// queued; and ADMIN_CALLSIGNS matches by base call everywhere.
import { describe, it, expect } from "vitest";
import { createPrivateKey } from "node:crypto";
import type { Env } from "@aprscaching/gateway/env";
import {
  authEnv,
  call,
  emailSignup,
  markCallVerified,
  operatorVerify,
  sysopVerifyCall,
  ORIGIN,
  type Res,
} from "./helpers/authflow.js";
import { serve } from "./helpers/fedpeer.js";
import { enrollBody, newBoxKey, signedHeaders, type BoxKey } from "../../../apps/ingest/src/gatewayauth.js";
import { gatewayTxGateLookup } from "../../../apps/ingest/src/callverify.js";

const OPS = { "x-operator-secret": "test-operator-secret" };
const SECRET = "test-ingest-secret";
const INGEST = { "x-ingest-secret": SECRET };
let ipSeq = 0;
const nextIp = () => `198.51.100.${++ipSeq % 250}`;

function boxKey(box: string): BoxKey {
  const { boxKey: pkcs8, publicKey } = newBoxKey();
  return {
    box,
    key: createPrivateKey({ key: Buffer.from(pkcs8, "base64url"), format: "der", type: "pkcs8" }),
    publicKey,
  };
}

interface World {
  env: Env;
  sysop: Res;
  other: Res;
}

async function world(extra: Record<string, unknown> = {}): Promise<World> {
  const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR", FIRST_PARTY_SITES: "OE3OTH-10", ...extra });
  const sysop = await emailSignup(env, "sysop@example.test", "OE8APR", nextIp());
  await operatorVerify(env, "OE8APR");
  const other = await emailSignup(env, "other@example.test", "OE3OTH", nextIp());
  await markCallVerified(env, "OE3OTH");
  return { env, sysop, other };
}

/** The sysop, signed in, enrols box `id` (for `callsign` when given). */
async function enrol(w: World, id: string, callsign?: string, headers?: Record<string, string>): Promise<BoxKey> {
  const k = boxKey(id);
  const code = await call(
    w.env,
    "POST",
    "/api/admin/boxes/codes",
    { label: id, ...(callsign ? { callsign } : {}) },
    headers ?? { cookie: w.sysop.cookie },
  );
  expect(code.status).toBe(201);
  expect((await call(w.env, "POST", "/ingest/enroll", enrollBody(k, code.data.code))).status).toBe(201);
  return k;
}

/** The box's transmit-gate lookup through the gateway in-process: signed by `key`, or with the shared secret. */
const gate = (env: Env, o: { key?: BoxKey; boxId?: string } = {}) =>
  gatewayTxGateLookup({
    ingestUrl: `${ORIGIN}/ingest`,
    secret: o.key ? "" : SECRET,
    boxKey: !!o.key,
    boxId: o.boxId,
    fetch: (async (u: string, init?: RequestInit) =>
      serve(env)(
        new Request(u, {
          headers: { ...(init?.headers as Record<string, string>), ...(o.key ? signedHeaders(o.key, "GET", u) : {}) },
        }),
      )) as typeof fetch,
  });

/** The receiving sites a box's frames may claim, as `/ingest/check` answers it. */
async function boxSites(env: Env, k: BoxKey): Promise<string[]> {
  const url = `${ORIGIN}/ingest/check`;
  const res = await serve(env)(new Request(url, { headers: signedHeaders(k, "GET", url) }));
  return ((await res.json()) as { sites: string[] }).sites;
}

const one = async <T = Record<string, unknown>>(env: Env, sql: string, ...binds: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...binds)
    .first<T>();
const count = async (env: Env, sql: string, ...binds: unknown[]) =>
  (await one<{ n: number }>(env, `SELECT COUNT(*) AS n FROM ${sql}`, ...binds))!.n;
const accountOf = async (env: Env, base: string) =>
  (await one<{ account_id: string }>(env, "SELECT account_id FROM account_callsigns WHERE callsign = ?", base))!
    .account_id;

const release = (w: World, cs: string, holder: string) =>
  call(
    w.env,
    "POST",
    `/api/admin/callsigns/${cs}`,
    { action: "release", reason: "licence belongs to someone else", holder },
    { cookie: w.sysop.cookie },
  );
const suspend = (w: World, cs: string, lift = false) =>
  call(
    w.env,
    "POST",
    `/api/admin/moderation/accounts/${cs}/${lift ? "unsuspend" : "suspend"}`,
    { reason: "sent spam", category: "spam" },
    { cookie: w.sysop.cookie },
  );
const trustBox = (w: World, box: string, sites: string[]) =>
  call(w.env, "POST", `/api/admin/boxes/${box}/trust`, { trusted: true, sites }, { cookie: w.sysop.cookie });

/** Status, pairing and command rows for `box`, as a polling, paired box leaves them. */
async function boxRows(env: Env, box: string) {
  await env.DB.prepare("INSERT INTO box_status (box_id, caps, last_seen) VALUES (?, '{}', 1)").bind(box).run();
  await env.DB.prepare("INSERT INTO box_pairings (box_id, code_hash, expires_at) VALUES (?, 'x', 9999999999)")
    .bind(box)
    .run();
}

describe("a box the sysop enrols for another ham", () => {
  it("belongs to that ham: their calls pass the transmit gate, the sysop's do not", async () => {
    const w = await world();
    const k = await enrol(w, "lent-1", "OE3OTH");
    expect((await one(w.env, "SELECT account_id FROM boxes WHERE box_id = 'lent-1'"))?.account_id).toBe(
      await accountOf(w.env, "OE3OTH"),
    );
    const got = await gate(w.env, { key: k })(["OE3OTH-1", "OE8APR-10"]);
    expect(got.get("OE3OTH-1")?.ok).toBe(true);
    expect(got.get("OE8APR-10")).toMatchObject({ ok: false, reason: "not held by this box's operator" });
  });

  it("enrolled with the operator secret for a call, belongs to the call's holder too", async () => {
    const w = await world();
    const k = await enrol(w, "lent-2", "OE3OTH", OPS);
    expect((await gate(w.env, { key: k })(["OE3OTH-1"])).get("OE3OTH-1")?.ok).toBe(true);
  });
});

describe("a revoked box", () => {
  it("loses its owner: enrolled again without one, it transmits for nobody", async () => {
    const w = await world();
    await enrol(w, "shack-1");
    expect((await call(w.env, "POST", "/api/admin/boxes/shack-1/revoke", {}, OPS)).status).toBe(200);
    expect(await count(w.env, "boxes WHERE box_id = 'shack-1'")).toBe(0);
    // the operator secret lets it in again: no account enrolled it, so nobody owns it
    const again = await enrol(w, "shack-1", undefined, OPS);
    expect((await gate(w.env, { key: again })(["OE8APR-10"])).get("OE8APR-10")?.ok).toBe(false);
  });

  it("enrolled anew by another account, takes the new owner instead of the paired one", async () => {
    const w = await world();
    // a box paired on the shared secret to OE3OTH, then enrolled with its own key by the sysop
    await w.env.DB.prepare("INSERT INTO boxes (box_id, account_id, created_at) VALUES ('shack-2', ?, 1)")
      .bind(await accountOf(w.env, "OE3OTH"))
      .run();
    const k = await enrol(w, "shack-2");
    const got = await gate(w.env, { key: k })(["OE8APR-10", "OE3OTH-1"]);
    expect(got.get("OE8APR-10")?.ok).toBe(true);
    expect(got.get("OE3OTH-1")?.ok).toBe(false);
  });
});

describe("the shared secret naming a box", () => {
  it("does not borrow the owner of a box that has its own key", async () => {
    const w = await world({ FIRST_PARTY_SITES: "" });
    await enrol(w, "lent-1", "OE3OTH");
    const got = await gate(w.env, { boxId: "lent-1" })(["OE3OTH-1"]);
    expect(got.get("OE3OTH-1")).toMatchObject({ ok: false, reason: "not held by this box's operator" });
  });

  it("still names a box paired on the shared secret", async () => {
    const w = await world({ FIRST_PARTY_SITES: "" });
    await w.env.DB.prepare("INSERT INTO boxes (box_id, account_id, created_at) VALUES ('paired-1', ?, 1)")
      .bind(await accountOf(w.env, "OE3OTH"))
      .run();
    expect((await gate(w.env, { boxId: "paired-1" })(["OE3OTH-1"])).get("OE3OTH-1")?.ok).toBe(true);
  });
});

describe("a call that changes hands", () => {
  it("released, takes its trusted sites and the boxes enrolled for it along", async () => {
    const w = await world();
    const k = await enrol(w, "lent-1", "OE3OTH");
    expect((await trustBox(w, "lent-1", ["OE3OTH-10"])).status).toBe(200);
    await w.env.DB.prepare(
      "INSERT INTO trusted_sites (site, trusted_by, trusted_at) VALUES ('OE3OTH-11', 'operator', 1)",
    ).run();
    expect(await boxSites(w.env, k)).toEqual(["OE3OTH-10"]);
    expect((await release(w, "OE3OTH", await accountOf(w.env, "OE3OTH"))).status).toBe(200);

    expect(await count(w.env, "trusted_sites WHERE site LIKE 'OE3OTH%'")).toBe(0);
    expect(await count(w.env, "box_trusted_sites WHERE box_id = 'lent-1'")).toBe(0);
    expect(await count(w.env, "boxes WHERE box_id = 'lent-1'")).toBe(0);
    expect((await one(w.env, "SELECT revoked_at FROM box_keys WHERE box_id = 'lent-1'"))?.revoked_at).not.toBeNull();

    // the new holder verifies the call: the old site on the shared secret is not their box
    const next = await emailSignup(w.env, "next@example.test", "OE3OTH", nextIp());
    expect(next.status).toBe(200);
    await markCallVerified(w.env, "OE3OTH");
    expect((await gate(w.env)(["OE3OTH-10"])).get("OE3OTH-10")?.ok).toBe(false);
  });

  it("erased, leaves no box trust, status or pairing behind", async () => {
    const w = await world();
    await enrol(w, "lent-1", "OE3OTH");
    expect((await trustBox(w, "lent-1", ["OE3OTH-10"])).status).toBe(200);
    await w.env.DB.prepare(
      "INSERT INTO trusted_sites (site, trusted_by, trusted_at) VALUES ('OE3OTH-11', 'operator', 1)",
    ).run();
    await boxRows(w.env, "lent-1");
    expect((await call(w.env, "POST", "/api/account/OE3OTH/delete", {}, { cookie: w.other.cookie })).status).toBe(200);

    expect(await count(w.env, "trusted_sites WHERE site LIKE 'OE3OTH%'")).toBe(0);
    for (const t of ["box_trusted_sites", "box_status", "box_pairings", "boxes", "box_keys"])
      expect(await count(w.env, `${t} WHERE box_id = 'lent-1'`), t).toBe(0);
  });

  it("an erased sysop keeps the boxes they enrolled for others; their own go with every row", async () => {
    const w = await world();
    await enrol(w, "own-1");
    await enrol(w, "lent-1", "OE3OTH");
    expect((await trustBox(w, "own-1", ["OE8APR-10"])).status).toBe(200);
    expect((await trustBox(w, "lent-1", ["OE3OTH-10"])).status).toBe(200);
    await boxRows(w.env, "own-1");
    await boxRows(w.env, "lent-1");
    const sysopAcct = await accountOf(w.env, "OE8APR");
    expect((await call(w.env, "POST", "/api/account/OE8APR/delete", {}, { cookie: w.sysop.cookie })).status).toBe(200);

    for (const t of ["box_trusted_sites", "box_status", "box_pairings", "boxes", "box_keys"])
      expect(await count(w.env, `${t} WHERE box_id = 'own-1'`), t).toBe(0);
    expect(await one(w.env, "SELECT revoked_at FROM box_keys WHERE box_id = 'lent-1'")).toMatchObject({
      revoked_at: null,
    });
    expect((await one(w.env, "SELECT account_id FROM boxes WHERE box_id = 'lent-1'"))?.account_id).toBe(
      await accountOf(w.env, "OE3OTH"),
    );
    expect(await count(w.env, "box_trusted_sites WHERE box_id = 'lent-1'")).toBe(1);
    // nothing names the erased account any more
    expect(await count(w.env, "box_keys WHERE enrolled_by = ?", sysopAcct)).toBe(0);
  });
});

describe("a suspension", () => {
  it("closes the transmit gate for the call and for every call on the owner's box", async () => {
    const w = await world({ FIRST_PARTY_SITES: "" });
    const k = await enrol(w, "lent-1", "OE3OTH");
    expect((await gate(w.env, { key: k })(["OE3OTH-1"])).get("OE3OTH-1")?.ok).toBe(true);
    expect((await suspend(w, "OE3OTH")).status).toBe(200);
    expect((await gate(w.env, { key: k })(["OE3OTH-1"])).get("OE3OTH-1")).toEqual({
      ok: false,
      reason: "suspended",
    });
    // the shared secret's paired box of a suspended owner: the owner's calls are refused as suspended
    await w.env.DB.prepare("INSERT INTO boxes (box_id, account_id, created_at) VALUES ('paired-1', ?, 1)")
      .bind(await accountOf(w.env, "OE3OTH"))
      .run();
    expect((await gate(w.env, { boxId: "paired-1" })(["OE8APR-10"])).get("OE8APR-10")).toEqual({
      ok: false,
      reason: "suspended",
    });
    expect((await suspend(w, "OE3OTH", true)).status).toBe(200);
    expect((await gate(w.env, { key: k })(["OE3OTH-1"])).get("OE3OTH-1")?.ok).toBe(true);
  });

  it("pauses the attestation of the owner's box until it is lifted", async () => {
    const w = await world();
    const k = await enrol(w, "lent-1", "OE3OTH");
    expect((await trustBox(w, "lent-1", ["OE3OTH-10"])).status).toBe(200);
    expect(await boxSites(w.env, k)).toEqual(["OE3OTH-10"]);
    expect((await suspend(w, "OE3OTH")).status).toBe(200);
    expect(await boxSites(w.env, k)).toEqual([]);
    expect((await suspend(w, "OE3OTH", true)).status).toBe(200);
    expect(await boxSites(w.env, k)).toEqual(["OE3OTH-10"]);
  });
});

describe("a revoked verification", () => {
  it("drops the call's queued outbox traffic and box commands", async () => {
    const w = await world();
    const user = await emailSignup(w.env, "usr@example.test", "DL1USR", nextIp());
    expect(user.status).toBe(200);
    expect((await sysopVerifyCall(w.env, w.sysop.cookie, "DL1USR")).status).toBe(201);
    await w.env.DB.prepare(
      "INSERT INTO aprs_outbox (ts, src_call, tocall, kind, payload) VALUES (?, 'DL1USR-7', 'APZACG', 'status', '>hi')",
    )
      .bind(Math.floor(Date.now() / 1000))
      .run();
    await w.env.DB.prepare(
      "INSERT INTO box_commands (box_id, callsign, kind, payload, status, created_at) VALUES ('b1', 'DL1USR-9', 'beacon', '{}', 'queued', ?)",
    )
      .bind(Math.floor(Date.now() / 1000))
      .run();
    const r = await call(w.env, "DELETE", "/api/admin/verifications/DL1USR", undefined, { cookie: w.sysop.cookie });
    expect(r.status).toBe(200);
    expect(await count(w.env, "aprs_outbox WHERE src_call LIKE 'DL1USR%'")).toBe(0);
    expect(await count(w.env, "box_commands WHERE callsign LIKE 'DL1USR%'")).toBe(0);
  });

  it("the drains re-check: an unverified call's queued rows never go out", async () => {
    const w = await world();
    const now = Math.floor(Date.now() / 1000);
    await w.env.DB.prepare(
      "INSERT INTO aprs_outbox (ts, src_call, tocall, kind, payload) VALUES (?, 'DL9NOV-7', 'APZACG', 'status', '>hi'), (?, 'OE8APR-7', 'APZACG', 'status', '>ok')",
    )
      .bind(now, now)
      .run();
    await w.env.DB.prepare(
      "INSERT INTO box_commands (box_id, callsign, kind, payload, status, created_at) VALUES ('b1', 'DL9NOV-9', 'beacon', '{}', 'queued', ?), ('b1', 'OE8APR-9', 'beacon', '{}', 'queued', ?)",
    )
      .bind(now, now)
      .run();
    const out = await call(w.env, "GET", "/outbox", undefined, INGEST);
    expect(out.data.items.map((i: { src_call: string }) => i.src_call)).toEqual(["OE8APR-7"]);
    const poll = await call(w.env, "GET", "/api/box/b1/commands", undefined, INGEST);
    expect(poll.data.commands.map((c: { callsign: string }) => c.callsign)).toEqual(["OE8APR-9"]);
    expect(await one(w.env, "SELECT status FROM box_commands WHERE callsign = 'DL9NOV-9'")).toMatchObject({
      status: "failed",
    });
  });
});

describe("ADMIN_CALLSIGNS listed with an SSID", () => {
  it("names the operator by base call: whoami, the TX gate and suspension agree", async () => {
    const w = await world({ ADMIN_CALLSIGNS: "OE8APR-10" });
    const who = await call(w.env, "GET", "/api/admin/whoami", undefined, { cookie: w.sysop.cookie });
    expect(who.data.sysop).toBe(true);
    expect((await gate(w.env)(["OE8APR-3"])).get("OE8APR-3")?.ok).toBe(true);
    const s = await call(
      w.env,
      "POST",
      "/api/admin/moderation/accounts/OE8APR/suspend",
      { reason: "sent spam", category: "spam" },
      OPS,
    );
    expect(s.status).toBe(409);
  });
});
