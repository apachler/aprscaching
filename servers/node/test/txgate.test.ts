// SPDX-License-Identifier: AGPL-3.0-or-later
// GET /ingest/txgate over the real gateway and a migrated SQLite, asked the way the ingest box asks it
// (apps/ingest/src/callverify.ts): a call passes only when it is control-verified AND belongs to whoever runs
// the box (its owning account, the operator of a site its credential may claim, or for the shared secret the
// instance's own operator calls). The shared secret's answer carries a MAC the box checks.
import { describe, it, expect } from "vitest";
import { createPrivateKey } from "node:crypto";
import type { Env } from "@aprscaching/gateway/env";
import { authEnv, call, emailSignup, markCallVerified, operatorVerify, ORIGIN } from "./helpers/authflow.js";
import { serve } from "./helpers/fedpeer.js";
import { enrollBody, newBoxKey, signedHeaders, type BoxKey } from "../../../apps/ingest/src/gatewayauth.js";
import { gatewayTxGateLookup } from "../../../apps/ingest/src/callverify.js";

const OPS = { "x-operator-secret": "test-operator-secret" };
const SECRET = "test-ingest-secret";

function boxKey(box: string): BoxKey {
  const { boxKey: pkcs8, publicKey } = newBoxKey();
  return {
    box,
    key: createPrivateKey({ key: Buffer.from(pkcs8, "base64url"), format: "der", type: "pkcs8" }),
    publicKey,
  };
}

async function world() {
  const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR", FIRST_PARTY_SITES: "OE3SIT-10" });
  const sysop = await emailSignup(env, "sysop@example.test", "OE8APR");
  await operatorVerify(env, "OE8APR");
  await emailSignup(env, "other@example.test", "OE3OTH");
  await markCallVerified(env, "OE3OTH");
  await emailSignup(env, "site@example.test", "OE3SIT");
  await markCallVerified(env, "OE3SIT");
  await emailSignup(env, "new@example.test", "OE9NEW");
  return { env, sysop: sysop.cookie };
}

/** The box's lookup, sent through the gateway in-process; a key box signs its request. */
const lookup = (env: Env, o: { secret?: string; key?: BoxKey; boxId?: string }) =>
  gatewayTxGateLookup({
    ingestUrl: `${ORIGIN}/ingest`,
    secret: o.secret ?? "",
    boxKey: !!o.key,
    boxId: o.boxId,
    fetch: (async (u: string, init?: RequestInit) =>
      serve(env)(
        new Request(u, {
          headers: { ...(init?.headers as Record<string, string>), ...(o.key ? signedHeaders(o.key, "GET", u) : {}) },
        }),
      )) as typeof fetch,
  });

describe("GET /ingest/txgate", () => {
  it("for the shared secret: the instance's operator calls and its sites' operators pass; others do not", async () => {
    const { env } = await world();
    const got = await lookup(env, { secret: SECRET })(["OE8APR-10", "OE3SIT-7", "OE3OTH-1", "OE9NEW-9"]);
    expect(Object.fromEntries(got)).toEqual({
      "OE8APR-10": { ok: true, reason: undefined },
      "OE3SIT-7": { ok: true, reason: undefined },
      "OE3OTH-1": { ok: false, reason: "not held by this box's operator" },
      "OE9NEW-9": { ok: false, reason: "not control-verified" },
    });
  });

  it("for the shared secret, a station the sysop trusts by call is not the box's: its verified call does not pass", async () => {
    const { env } = await world();
    await emailSignup(env, "trusted@example.test", "OE3TRU");
    await markCallVerified(env, "OE3TRU");
    await env.DB.prepare(
      "INSERT INTO trusted_sites (site, trusted_by, trusted_at) VALUES ('OE3TRU-10', 'operator', 0)",
    ).run();
    const got = await lookup(env, { secret: SECRET })(["OE3TRU-1", "OE3SIT-7"]);
    expect(got.get("OE3TRU-1")).toMatchObject({ ok: false, reason: "not held by this box's operator" });
    expect(got.get("OE3SIT-7")?.ok).toBe(true); // FIRST_PARTY_SITES: the instance's own site
  });

  it("for an enrolled box: the calls of the account that owns it, and no one else's", async () => {
    const { env, sysop } = await world();
    // the sysop creates the code signed in, so the box is the sysop's
    const owned = boxKey("shack-1");
    const code = await call(env, "POST", "/api/admin/boxes/codes", { label: "shack" }, { cookie: sysop });
    expect((await call(env, "POST", "/ingest/enroll", enrollBody(owned, code.data.code))).status).toBe(201);
    const got = await lookup(env, { key: owned })(["OE8APR-10", "OE3OTH-1", "OE3SIT-7"]);
    expect(got.get("OE8APR-10")?.ok).toBe(true);
    expect(got.get("OE3OTH-1")).toMatchObject({ ok: false, reason: "not held by this box's operator" });
    // the shared secret's sites are not this box's to claim
    expect(got.get("OE3SIT-7")?.ok).toBe(false);

    // a box let in with the operator secret has no owning account: even the operator's call does not pass
    const lent = boxKey("lent-1");
    const code2 = await call(env, "POST", "/api/admin/boxes/codes", { label: "lent" }, OPS);
    expect((await call(env, "POST", "/ingest/enroll", enrollBody(lent, code2.data.code))).status).toBe(201);
    expect((await lookup(env, { key: lent })(["OE8APR-10"])).get("OE8APR-10")?.ok).toBe(false);
  });

  it("refuses a wrong secret, and malformed calls or nonce", async () => {
    const { env } = await world();
    await expect(lookup(env, { secret: "wrong" })(["OE8APR-10"])).rejects.toThrow(/HTTP 401/);
    const ask = (q: string) =>
      serve(env)(new Request(`${ORIGIN}/ingest/txgate?${q}`, { headers: { "x-ingest-secret": SECRET } }));
    expect((await ask("calls=OE8APR-10")).status).toBe(400); // no nonce
    expect((await ask("calls=NOT%20A%20CALL&nonce=abcdefghijklmnop")).status).toBe(400);
    const seventeen = Array.from({ length: 17 }, (_, i) => `OE${i}AA`).join(",");
    expect((await ask(`calls=${seventeen}&nonce=abcdefghijklmnop`)).status).toBe(400);
    expect((await ask(`calls=OE8APR-10&nonce=abcdefghijklmnop`)).status).toBe(200);
  });
});
