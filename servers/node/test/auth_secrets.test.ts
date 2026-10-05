// SPDX-License-Identifier: AGPL-3.0-or-later
// Three secrets, three planes. INGEST_SECRET authorises only what the ingest box does (packets, the
// outbox, BBS delivery, over-APRS logging, box polling). OPERATOR_SECRET authorises the operator's own
// machine calls to instance-wide configuration. SESSION_SECRET signs user sessions, and nothing a
// holder of the ingest secret knows lets them mint one.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup } from "./helpers/authflow.js";
import { freshDb } from "./helpers/fedpeer.js";

const INGEST = { "x-ingest-secret": "test-ingest-secret" };
const OPERATOR = { "x-operator-secret": "test-operator-secret" };

describe("the ingest secret is not an operator credential", () => {
  it("POST /verify/operator refuses the ingest secret and accepts the operator secret", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR" });
    expect((await call(env, "POST", "/verify/operator", { callsign: "OE8APR" }, INGEST)).status).toBe(401);
    const ok = await call(env, "POST", "/verify/operator", { callsign: "OE8APR" }, OPERATOR);
    expect(ok.status).toBe(200);
    expect(ok.data.verified).toBe(true);
  });

  it("an unset OPERATOR_SECRET closes the machine path (fail closed)", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR", OPERATOR_SECRET: undefined });
    expect((await call(env, "POST", "/verify/operator", { callsign: "OE8APR" }, OPERATOR)).status).toBe(401);
    expect(
      (await call(env, "POST", "/verify/operator", { callsign: "OE8APR" }, { "x-operator-secret": "" })).status,
    ).toBe(401);
    const trust = await call(
      env,
      "POST",
      "/federation/peers/trust",
      { url: "https://p.example", trust: "blocked" },
      OPERATOR,
    );
    expect(trust.status).toBe(401);
  });

  it("operator configuration writes refuse the ingest secret", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR" });
    const writes: Array<[string, string, unknown]> = [
      ["POST", "/federation/peers/trust", { url: "https://p.example", trust: "blocked" }],
      ["GET", "/federation/peers", undefined],
      ["POST", "/federation/peers/sync", { url: "https://p.example" }],
      ["POST", "/federation/peers/44net", { callsign: "OE1XYZ" }],
      ["POST", "/api/bbs/forward", { partner: "oe1bbb", route: "OE" }],
      ["POST", "/api/bbs/partners", { call: "OE1BBB-1", ha: "OE1BBB.AUT.EU", proto: "rf-fbb" }],
      ["DELETE", "/api/bbs/partners/1", undefined],
      ["DELETE", "/api/bbs/forward/1", undefined],
      ["POST", "/federation/bbs/enqueue", {}],
      ["POST", "/federation/relay/oe.spoke/dispatch", {}],
    ];
    for (const [m, p, b] of writes) {
      const r = await call(env, m, p, b, INGEST);
      expect([401, 403], `${m} ${p} with the ingest secret`).toContain(r.status);
    }
    const rule = await call(env, "POST", "/api/bbs/forward", { partner: "oe1bbb", route: "OE" }, OPERATOR);
    expect(rule.status).toBe(201);
    const partner = await call(
      env,
      "POST",
      "/api/bbs/partners",
      { call: "OE1BBB-1", ha: "OE1BBB.AUT.EU", proto: "rf-fbb" },
      OPERATOR,
    );
    expect(partner.status).toBe(201);
  });

  it("the ingest plane keeps what the ingest box does: partner list read, node mirror, heard frames", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR" });
    expect((await call(env, "GET", "/api/bbs/partners", undefined, INGEST)).status).toBe(200);
    const node = await call(
      env,
      "POST",
      "/api/node/nodes",
      { dest: "OE1NOD-1", alias: "VIE", neighbor: "OE1NOD-1", quality: 200, port: "kiss" },
      INGEST,
    );
    expect(node.status).toBeLessThan(300);
    // a wrong ingest secret is still a bad credential
    expect((await call(env, "GET", "/api/bbs/partners", undefined, { "x-ingest-secret": "nope" })).status).toBe(401);
  });
});

describe("sessions need their own SESSION_SECRET", () => {
  it("no session is minted without SESSION_SECRET", async () => {
    const env = authEnv({ SESSION_SECRET: undefined });
    const r = await emailSignup(env, "nosess@example.test", "DL1NOS");
    expect(r.cookie).toBe("");
    expect(r.status).toBe(503);
  });

  it("a SESSION_SECRET equal to the ingest secret is refused", async () => {
    const env = authEnv({ SESSION_SECRET: "test-ingest-secret" });
    const r = await emailSignup(env, "same@example.test", "DL1SAM");
    expect(r.cookie).toBe("");
  });

  it("a cookie signed with a key derived from the ingest secret is rejected", async () => {
    const env = authEnv();
    const signup = await emailSignup(env, "forge@example.test", "DL1FRG");
    expect(signup.status).toBe(200);
    const acct = (await env.DB.prepare("SELECT account_id FROM accounts WHERE callsign='DL1FRG'").first<{
      account_id: string;
    }>())!.account_id;
    const forge = async (payload: string) => {
      const k = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode("test-ingest-secret:session"),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(payload)));
      return `acs=${btoa(payload)}.${btoa(String.fromCharCode(...sig))}`;
    };
    for (const payload of [`DL1FRG.${Date.now()}`, `v2.${acct}.0.DL1FRG.${Date.now()}`]) {
      const who = await call(env, "GET", "/auth/session", undefined, { cookie: await forge(payload) });
      expect(who.data.callsign).toBeNull();
    }
  });
});

describe("a session is bound to its account", () => {
  it("an erased account's cookie never acts as the next holder of the same call", async () => {
    const db = freshDb().DB;
    const env = authEnv({}, db);
    const a = await emailSignup(env, "alice@example.test", "DL1TKO");
    expect(a.status).toBe(200);
    const erase = await call(env, "POST", "/api/account/DL1TKO/delete", {}, { cookie: a.cookie });
    expect(erase.status).toBe(200);
    const b = await emailSignup(env, "bob@example.test", "DL1TKO");
    expect(b.status).toBe(200);
    // A's old cookie resolves to nobody — not to B
    const who = await call(env, "GET", "/auth/session", undefined, { cookie: a.cookie });
    expect(who.data.callsign).toBeNull();
    const exp = await call(env, "POST", "/api/account/DL1TKO/export", {}, { cookie: a.cookie });
    expect(exp.status).toBe(401);
    // B's own cookie still works
    expect((await call(env, "GET", "/auth/session", undefined, { cookie: b.cookie })).data.callsign).toBe("DL1TKO");
  });

  it("a legacy token (callsign.timestamp, no account id) is invalid", async () => {
    const env = authEnv();
    await emailSignup(env, "legacy@example.test", "DL1LEG");
    const k = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("test-session-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const payload = `DL1LEG.${Date.now()}`;
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(payload)));
    const cookie = `acs=${btoa(payload)}.${btoa(String.fromCharCode(...sig))}`;
    expect((await call(env, "GET", "/auth/session", undefined, { cookie })).data.callsign).toBeNull();
  });

  it("POST /auth/logout-all ends every session of the account", async () => {
    const env = authEnv();
    const first = await emailSignup(env, "multi@example.test", "DL1MUL");
    // a second device signs in by email
    const start = await call(env, "POST", "/auth/email/start", { email: "multi@example.test" });
    const second = await call(env, "POST", "/auth/email/verify", { token: start.data.devToken });
    expect(second.cookie).not.toBe("");
    const out = await call(env, "POST", "/auth/logout-all", {}, { cookie: second.cookie });
    expect(out.status).toBe(200);
    for (const c of [first.cookie, second.cookie])
      expect((await call(env, "GET", "/auth/session", undefined, { cookie: c })).data.callsign).toBeNull();
    // signed out, logout-all needs a session
    expect((await call(env, "POST", "/auth/logout-all", {})).status).toBe(401);
  });

  it("a callsign change ends the sessions that carried the old call", async () => {
    const env = authEnv();
    const s = await emailSignup(env, "chg@example.test", "DL1OLD");
    const chg = await call(env, "POST", "/auth/callsign", { callsign: "DL1NEW" }, { cookie: s.cookie });
    expect(chg.status).toBe(200);
    expect(chg.cookie).not.toBe("");
    expect((await call(env, "GET", "/auth/session", undefined, { cookie: s.cookie })).data.callsign).toBeNull();
    expect((await call(env, "GET", "/auth/session", undefined, { cookie: chg.cookie })).data.callsign).toBe("DL1NEW");
  });
});

describe("device keys bind only through a signed-in account", () => {
  const newKey = async () => {
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pub = Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("base64url");
    return { kp, pub };
  };

  it("the ingest secret cannot register a key, so it cannot erase or export an account", async () => {
    const env = authEnv({ INSTANCE: "gw.test" });
    const victim = await emailSignup(env, "victim@example.test", "DL1VIC");
    expect(victim.status).toBe(200);
    const { kp, pub } = await newKey();
    const reg = await call(env, "POST", "/keys/register", { callsign: "DL1VIC", publicKey: pub }, INGEST);
    expect(reg.status).toBe(401);
    const { accountActionMessage } = await import("@aprscaching/shared");
    for (const action of ["delete", "export"]) {
      const at = Math.floor(Date.now() / 1000);
      const msg = new TextEncoder().encode(
        accountActionMessage({ action, callsign: "DL1VIC", instance: "gw.test", at }),
      );
      const sig = Buffer.from(await crypto.subtle.sign("Ed25519", kp.privateKey, msg)).toString("base64url");
      const r = await call(env, "POST", `/api/account/DL1VIC/${action}`, { key: pub, sig, at });
      expect(r.status, action).toBe(403);
    }
    // the account is intact
    expect((await call(env, "GET", "/auth/session", undefined, { cookie: victim.cookie })).data.callsign).toBe(
      "DL1VIC",
    );
  });

  it("a signed-in holder registers a key for their own call", async () => {
    const env = authEnv();
    const me = await emailSignup(env, "keys@example.test", "DL1KEY");
    const { pub } = await newKey();
    const reg = await call(
      env,
      "POST",
      "/keys/register",
      { callsign: "DL1KEY-7", publicKey: pub },
      { cookie: me.cookie },
    );
    expect(reg.status).toBe(200);
    const other = await call(
      env,
      "POST",
      "/keys/register",
      { callsign: "DL1ZZZ", publicKey: pub },
      { cookie: me.cookie },
    );
    expect(other.status).toBe(403);
  });
});
