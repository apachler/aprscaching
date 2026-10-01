// SPDX-License-Identifier: AGPL-3.0-or-later
// Ingest boxes enrolled with a one-time code sign their requests with their own key. These drive the real
// gateway over a migrated SQLite with the ingest box's own signing code (apps/ingest gatewayauth.ts): a code
// works once and only while fresh, a signature covers the method, path, time and body and is accepted once,
// revoking one box cuts off that box alone, the shared secret keeps working, a box acts only for itself,
// and enrolling changes no trust — a site still counts for Tier A only through FIRST_PARTY_SITES.
import { describe, it, expect } from "vitest";
import { createPrivateKey, sign } from "node:crypto";
import { SIG_DOMAIN, boxRequestMessage } from "@aprscaching/shared";
import type { Env } from "@aprscaching/gateway/env";
import { authEnv, call, emailSignup, operatorVerify, ORIGIN } from "./helpers/authflow.js";
import { serve } from "./helpers/fedpeer.js";
import { enrollBody, newBoxKey, signedHeaders, type BoxKey } from "../../../apps/ingest/src/gatewayauth.js";

const OPS = { "x-operator-secret": "test-operator-secret" };
// the live WebSocket fan-out is out of scope: a room stub accepts and discards the deltas
const room = { fetch: async () => new Response(null, { status: 204 }) };
const ROOMS = { idFromName: (n: string) => n, get: () => room };

function boxEnv(extra: Record<string, unknown> = {}): Env {
  return authEnv({ ROOMS, FIRST_PARTY_SITES: "OE8XXX,OE1ABC", ...extra });
}

function boxKey(box: string): BoxKey {
  const { boxKey: pkcs8, publicKey } = newBoxKey();
  return {
    box,
    key: createPrivateKey({ key: Buffer.from(pkcs8, "base64url"), format: "der", type: "pkcs8" }),
    publicKey,
  };
}

async function newCode(env: Env, body: Record<string, unknown> = {}, headers: Record<string, string> = OPS) {
  return call(env, "POST", "/api/admin/boxes/codes", body, headers);
}

async function enroll(env: Env, k: BoxKey, code: string) {
  return call(env, "POST", "/ingest/enroll", enrollBody(k, code));
}

/** One request signed by `k` (or with `headers` instead), sent as it is built. */
async function signed(
  env: Env,
  k: BoxKey,
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string>,
) {
  const url = `${ORIGIN}${path}`;
  const h = headers ?? signedHeaders(k, method, url, body);
  const res = await serve(env)(
    new Request(url, { method, headers: { "content-type": "application/json", ...h }, body }),
  );
  return { status: res.status, data: await res.json().catch(() => null), headers: h };
}

const position = (src: string, port: string, igateCall?: string) => ({
  src,
  dst: "APRS",
  path: [],
  payload: "!4704.41N/01526.27E>",
  kind: "position",
  heardVia: "rf",
  port,
  ts: Math.floor(Date.now() / 1000),
  ...(igateCall ? { igateCall } : {}),
});

async function enrolled(env: Env, box = "shack-1", codeBody: Record<string, unknown> = {}) {
  const k = boxKey(box);
  const c = await newCode(env, codeBody);
  const e = await enroll(env, k, c.data.code);
  expect(e.status).toBe(201);
  return k;
}

describe("enrollment codes", () => {
  it("only a sysop or the operator secret creates one, 80 bits in four groups, expiring in 10-15 minutes", async () => {
    const env = boxEnv();
    expect((await newCode(env, {}, {})).status).toBe(403);
    expect((await newCode(env, {}, { "x-ingest-secret": "test-ingest-secret" })).status).toBe(403);
    const c = await newCode(env, { label: "shack", ttlMin: 99 });
    expect(c.status).toBe(201);
    expect(c.data.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const ttl = c.data.expiresAt - Math.floor(Date.now() / 1000);
    expect(ttl).toBeGreaterThan(14 * 60);
    expect(ttl).toBeLessThanOrEqual(15 * 60);
    // only a hash is stored, and the list never shows a code
    const stored = await env.DB.prepare("SELECT code_hash FROM box_enrollment_codes").first<{ code_hash: string }>();
    expect(stored!.code_hash).not.toContain(c.data.code.replace(/-/g, ""));
    const list = await call(env, "GET", "/api/admin/boxes", undefined, OPS);
    expect(JSON.stringify(list.data)).not.toContain(c.data.code);
    expect(list.data.openCodes).toHaveLength(1);
  });

  it("a code enrolls one box once; a wrong, reused or expired code is refused", async () => {
    const env = boxEnv();
    const c = await newCode(env);
    expect((await enroll(env, boxKey("a"), "AAAA-BBBB-CCCC-DDDD")).status).toBe(403);
    expect((await enroll(env, boxKey("a"), c.data.code)).status).toBe(201);
    expect((await enroll(env, boxKey("b"), c.data.code)).status).toBe(403);
    const old = await newCode(env);
    await env.DB.prepare("UPDATE box_enrollment_codes SET expires_at = 1 WHERE used_at IS NULL").run();
    expect((await enroll(env, boxKey("c"), old.data.code)).status).toBe(403);
  });

  it("the box proves it holds the key, and its clock must be near the gateway's", async () => {
    const env = boxEnv();
    const c = await newCode(env);
    const k = boxKey("a");
    const other = boxKey("a");
    const forged = { ...enrollBody(other, c.data.code), key: k.publicKey }; // signed by another key
    expect((await call(env, "POST", "/ingest/enroll", forged)).status).toBe(400);
    const skewed = { ...enrollBody(k, c.data.code), at: Math.floor(Date.now() / 1000) - 900 };
    expect((await call(env, "POST", "/ingest/enroll", skewed)).status).toBe(400);
    // neither attempt used the code up
    expect((await enroll(env, k, c.data.code)).status).toBe(201);
  });

  it("an enrolled box id is not taken over by a second enrollment", async () => {
    const env = boxEnv();
    await enrolled(env, "shack-1");
    const c = await newCode(env);
    expect((await enroll(env, boxKey("shack-1"), c.data.code)).status).toBe(409);
  });

  it("enrollment attempts are rate-limited per address", async () => {
    const env = boxEnv();
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await enroll(env, boxKey(`x${i}`), "AAAA-BBBB-CCCC-DDDD")).status);
    expect(codes.slice(0, 10).every((s) => s === 403)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });

  it("the sysop who created the code owns the box for remote control", async () => {
    const env = boxEnv({ ADMIN_CALLSIGNS: "OE8APR" });
    const s = await emailSignup(env, "op@example.test", "OE8APR");
    await operatorVerify(env, "OE8APR");
    const c = await newCode(env, {}, { cookie: s.cookie });
    expect(c.status).toBe(201);
    expect((await enroll(env, boxKey("shack-1"), c.data.code)).status).toBe(201);
    const owner = await env.DB.prepare("SELECT account_id FROM boxes WHERE box_id = 'shack-1'").first<{
      account_id: string;
    }>();
    const acct = await env.DB.prepare("SELECT account_id FROM accounts WHERE callsign = 'OE8APR'").first<{
      account_id: string;
    }>();
    expect(owner?.account_id).toBe(acct?.account_id);
  });
});

describe("signed requests", () => {
  it("a signed request has the ingest plane's rights", async () => {
    const env = boxEnv();
    const k = await enrolled(env);
    const check = await signed(env, k, "GET", "/ingest/check");
    expect(check.status).toBe(200);
    expect(check.data.box).toBe("shack-1");
    const body = JSON.stringify({ packets: [position("OE3BOX", "aprs-is")] });
    expect((await signed(env, k, "POST", "/ingest", body)).status).toBe(200);
    const row = await env.DB.prepare("SELECT source FROM positions WHERE callsign = 'OE3BOX'").first<{
      source: string;
    }>();
    expect(row?.source).toBe("firehose");
  });

  it("an altered body, path or method breaks the signature", async () => {
    const env = boxEnv();
    const k = await enrolled(env);
    const body = JSON.stringify({ packets: [position("OE3BOX", "aprs-is")] });
    const h = signedHeaders(k, "POST", `${ORIGIN}/ingest`, body);
    const evil = JSON.stringify({ packets: [position("OE3EVL", "aprs-is")] });
    expect((await signed(env, k, "POST", "/ingest", evil, h)).status).toBe(401);
    const q = signedHeaders(k, "GET", `${ORIGIN}/api/box/shack-1/commands?tx=0`);
    expect((await signed(env, k, "GET", "/api/box/shack-1/commands?tx=1", undefined, q)).status).toBe(401);
    const g = signedHeaders(k, "GET", `${ORIGIN}/ingest/check`);
    expect((await signed(env, k, "POST", "/ingest/check", undefined, g)).status).not.toBe(200);
  });

  it("a signature is accepted once, and only while fresh", async () => {
    const env = boxEnv();
    const k = await enrolled(env);
    const first = await signed(env, k, "GET", "/ingest/check");
    expect(first.status).toBe(200);
    expect((await signed(env, k, "GET", "/ingest/check", undefined, first.headers)).status).toBe(401);
    // a correctly signed request from ten minutes ago
    const at = Math.floor(Date.now() / 1000) - 600;
    const nonce = "AAAAAAAAAAAAAAAAAAAAAA";
    const digest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // empty body
    const msg = boxRequestMessage({ box: k.box, method: "GET", path: "/ingest/check", at, nonce, digest });
    const sig = sign(null, Buffer.from(SIG_DOMAIN.box + msg), k.key).toString("base64url");
    const stale = { "x-box-id": k.box, "x-box-at": String(at), "x-box-nonce": nonce, "x-box-sig": sig };
    expect((await signed(env, k, "GET", "/ingest/check", undefined, stale)).status).toBe(401);
  });

  it("a key signs only for its own box id", async () => {
    const env = boxEnv();
    const k = await enrolled(env, "shack-1");
    const impostor: BoxKey = { ...k, box: "shack-2" };
    expect((await signed(env, impostor, "GET", "/ingest/check")).status).toBe(401);
    expect((await signed(env, k, "GET", "/api/box/shack-1/commands")).status).toBe(200);
    expect((await signed(env, k, "GET", "/api/box/other-box/commands")).status).toBe(403);
  });

  it("revoking a box cuts it off at once and leaves other boxes and the shared secret working", async () => {
    const env = boxEnv();
    const a = await enrolled(env, "shack-1");
    const b = await enrolled(env, "shack-2");
    expect((await call(env, "POST", "/api/admin/boxes/shack-1/revoke", {}, {})).status).toBe(403);
    expect((await call(env, "POST", "/api/admin/boxes/shack-1/revoke", {}, OPS)).status).toBe(200);
    expect((await signed(env, a, "GET", "/ingest/check")).status).toBe(401);
    expect((await signed(env, b, "GET", "/ingest/check")).status).toBe(200);
    const secret = await call(env, "GET", "/ingest/check", undefined, { "x-ingest-secret": "test-ingest-secret" });
    expect(secret.status).toBe(200);
    const list = await call(env, "GET", "/api/admin/boxes", undefined, OPS);
    expect(list.data.boxes.find((x: { box: string }) => x.box === "shack-1").revokedAt).toBeGreaterThan(0);
    // the revoked box comes back only with a fresh code and key
    const again = await enrolled(env, "shack-1");
    expect((await signed(env, again, "GET", "/ingest/check")).status).toBe(200);
  });
});

describe("trust is unchanged by enrollment", () => {
  const stored = (env: Env, call: string) =>
    env.DB.prepare("SELECT igate_call FROM positions WHERE callsign = ?")
      .bind(call)
      .first<{ igate_call: string | null }>();

  it("an enrolled box names its receiving site like a box on the shared secret", async () => {
    const env = boxEnv();
    const k = await enrolled(env);
    const body = JSON.stringify({ packets: [position("OE3RF1", "kiss-tnc", "OE8XXX")] });
    expect((await signed(env, k, "POST", "/ingest", body)).status).toBe(200);
    const viaSecret = JSON.stringify({ packets: [position("OE3RF2", "kiss-tnc", "OE8XXX")] });
    await call(env, "POST", "/ingest", JSON.parse(viaSecret), { "x-ingest-secret": "test-ingest-secret" });
    expect((await stored(env, "OE3RF1"))?.igate_call).toBe((await stored(env, "OE3RF2"))?.igate_call);
    // enrolling did not list the box anywhere: FIRST_PARTY_SITES is the sysop's setting alone
    expect(env.FIRST_PARTY_SITES).toBe("OE8XXX,OE1ABC");
  });

  it("a box enrolled for a callsign names only sites of that call", async () => {
    const env = boxEnv();
    const k = await enrolled(env, "shack-1", { callsign: "OE8XXX-10" });
    const body = JSON.stringify({
      packets: [position("OE3OWN", "kiss-tnc", "OE8XXX-10"), position("OE3FOE", "kiss-tnc", "OE1ABC")],
    });
    expect((await signed(env, k, "POST", "/ingest", body)).status).toBe(200);
    expect((await stored(env, "OE3OWN"))?.igate_call).toBe("OE8XXX-10");
    expect((await stored(env, "OE3FOE"))?.igate_call).toBeNull();
  });
});
