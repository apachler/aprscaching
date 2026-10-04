// SPDX-License-Identifier: AGPL-3.0-or-later
// Callsign control-verification by an RF transmission: the holder asks for a code, transmits
// `VERIFY <code>` to the service call, and the call is verified only when a receiving site this instance
// attests heard it on its own radio. APRS-IS is public, so nothing that travels over it — the code, or a
// copy of the message — proves control of the licence. The operator bootstraps their own call with the
// operator secret, and a sysop may verify a call by hand, on the record.
import { describe, it, expect } from "vitest";
import { handleRadioMessage, type RadioMessage } from "@aprscaching/gateway/radiolog";
import type { Env } from "@aprscaching/gateway/env";
import { authEnv, call, emailSignup, operatorVerify, rfVerify } from "./helpers/authflow.js";

const SECRET = { "x-ingest-secret": "test-ingest-secret" };
const OPERATOR = { "x-operator-secret": "test-operator-secret" };

const rfEnv = (extra: Record<string, unknown> = {}) => authEnv({ FIRST_PARTY_SITES: "OE8XXX", ...extra });

const verified = async (env: Env, cs: string) =>
  (await call(env, "GET", `/verify/aprs/status?callsign=${cs}`)).data?.verified === true;

const outboxCount = async (env: Env) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM aprs_outbox").first<{ n: number }>())!.n;

/** `VERIFY <code>` from `src` to the service call, heard by the attested site OE8XXX on its TNC. */
const heard = (src: string, text: string, o: Partial<RadioMessage> = {}): RadioMessage => ({
  src,
  text,
  msgNo: "5",
  ts: Math.floor(Date.now() / 1000),
  port: "kiss-tnc",
  heardVia: "rf",
  igateCall: "OE8XXX",
  path: ["WIDE1-1", "qAR", "OE8XXX"],
  signed: false,
  ...o,
});

async function started(env: Env, email = "owner@example.test", cs = "OE8APR") {
  const me = await emailSignup(env, email, cs);
  const s = await call(env, "POST", "/verify/aprs/start", { callsign: cs }, { cookie: me.cookie });
  return { me, s };
}

const row = (env: Env, cs: string) =>
  env.DB.prepare("SELECT * FROM callsign_verifications WHERE callsign=?").bind(cs).first<Record<string, unknown>>();
/** A held call's verification as its account sees it — derived from the one store — or null if unheld. */
async function held(env: Env, cs: string): Promise<{ verified: number; method: string | null } | null> {
  if (!(await env.DB.prepare("SELECT 1 AS x FROM account_callsigns WHERE callsign=?").bind(cs).first())) return null;
  const v = await env.DB.prepare("SELECT method FROM callsign_verifications WHERE callsign=? AND status='verified'")
    .bind(cs)
    .first<{ method: string | null }>();
  return { verified: v ? 1 : 0, method: v?.method ?? null };
}

describe("starting an RF verification", () => {
  it("returns the code, the service call and the exact text to send, and queues nothing", async () => {
    const env = rfEnv();
    const { s } = await started(env);
    expect(s.status).toBe(200);
    expect(s.data.code).toMatch(/^\d{6}$/);
    expect(s.data.to).toBe("APRSCG");
    expect(s.data.text).toBe(`VERIFY ${s.data.code}`);
    expect(s.data.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(await outboxCount(env)).toBe(0);
    expect(await verified(env, "OE8APR")).toBe(false);
  });

  it("names the configured service call", async () => {
    const env = rfEnv({ SERVICE_CALL: "OE8BBS" });
    const { s } = await started(env);
    expect(s.data.to).toBe("OE8BBS");
  });

  it("needs a session whose account holds the call", async () => {
    const env = rfEnv();
    await emailSignup(env, "owner@example.test", "OE8APR");
    const other = await emailSignup(env, "other@example.test", "DL1AAA");
    expect(
      (await call(env, "POST", "/verify/aprs/start", { callsign: "OE8APR" }, { cookie: other.cookie })).status,
    ).toBe(403);
    expect((await call(env, "POST", "/verify/aprs/start", { callsign: "OE8APR" })).status).toBe(401);
    // the ingest secret does not start a challenge
    expect((await call(env, "POST", "/verify/aprs/start", { callsign: "OE8APR" }, SECRET)).status).toBe(401);
  });

  it("the browser cannot confirm by typing the code back", async () => {
    const env = rfEnv();
    const { me, s } = await started(env);
    const r = await call(
      env,
      "POST",
      "/verify/aprs/confirm",
      { callsign: "OE8APR", code: s.data.code },
      { cookie: me.cookie },
    );
    expect(r.status).toBe(404);
    expect(await verified(env, "OE8APR")).toBe(false);
  });
});

describe("a VERIFY message heard at an attested site", () => {
  it("verifies the call through the real ingest, from any SSID, and acks the message", async () => {
    const env = rfEnv();
    const { s } = await started(env);
    const r = await call(
      env,
      "POST",
      "/ingest",
      {
        packets: [
          {
            src: "OE8APR-7",
            dst: "APRS",
            path: ["WIDE1-1", "qAR", "OE8XXX"],
            payload: `:APRSCG   :verify ${s.data.code}{5`,
            kind: "message",
            heardVia: "rf",
            igateCall: "OE8XXX",
            port: "kiss-tnc",
            ts: Math.floor(Date.now() / 1000),
          },
        ],
      },
      SECRET,
    );
    expect(r.status).toBe(200);
    expect(await verified(env, "OE8APR")).toBe(true);
    expect(await row(env, "OE8APR")).toMatchObject({ status: "verified", method: "rf_heard", challenge: null });
    expect(await held(env, "OE8APR")).toEqual({ verified: 1, method: "rf_heard" });
    const out = await env.DB.prepare("SELECT payload FROM aprs_outbox ORDER BY id").all<{ payload: string }>();
    expect(out.results.map((o) => o.payload)).toContain(":OE8APR-7 :ack5");
    // no FOUND/DNF command was recorded for it
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM radio_commands").first<{ n: number }>())!.n).toBe(0);
  });

  it.each([
    ["over APRS-IS", { port: "aprs-is", heardVia: "aprs_is", igateCall: "OE8XXX", path: ["TCPIP*", "qAR", "OE8XXX"] }],
    ["at an unattested site", { igateCall: "OE9ZZZ", path: ["WIDE1-1", "qAR", "OE9ZZZ"] }],
    ["in a signed browser batch", { signed: true }],
    ["from a different base call", { src: "OE8APX-7" }],
    ["over an internet tunnel", { port: "axudp" }],
  ])("does not verify when it arrives %s", async (_label, o) => {
    const env = rfEnv();
    const { s } = await started(env);
    await handleRadioMessage(env, heard("OE8APR-7", `VERIFY ${s.data.code}`, o as Partial<RadioMessage>));
    expect(await verified(env, "OE8APR")).toBe(false);
    expect((await held(env, "OE8APR"))!.verified).toBe(0);
    // the challenge is still open: a real on-air copy afterwards completes it
    await handleRadioMessage(env, heard("OE8APR-9", `VERIFY ${s.data.code}`));
    expect(await verified(env, "OE8APR")).toBe(true);
  });

  it("with no attested site configured nothing verifies", async () => {
    const env = authEnv();
    const { s } = await started(env);
    await handleRadioMessage(env, heard("OE8APR-7", `VERIFY ${s.data.code}`));
    expect(await verified(env, "OE8APR")).toBe(false);
  });

  it("a wrong code counts an attempt and locks the challenge at the cap", async () => {
    const env = rfEnv();
    const { s } = await started(env);
    const wrong = s.data.code === "000000" ? "111111" : "000000";
    await handleRadioMessage(env, heard("OE8APR-7", `VERIFY ${wrong}`, { msgNo: "1" }));
    expect((await row(env, "OE8APR"))!.attempts).toBe(1);
    for (let i = 2; i <= 5; i++)
      await handleRadioMessage(env, heard("OE8APR-7", `VERIFY ${wrong}`, { msgNo: String(i) }));
    await handleRadioMessage(env, heard("OE8APR-7", `VERIFY ${s.data.code}`, { msgNo: "9" }));
    expect(await verified(env, "OE8APR")).toBe(false);
  });

  it("a wrong code that did not reach the site costs no attempt", async () => {
    const env = rfEnv();
    await started(env);
    await handleRadioMessage(env, heard("OE8APR-7", "VERIFY 000001", { port: "aprs-is", heardVia: "aprs_is" }));
    expect((await row(env, "OE8APR"))!.attempts).toBe(0);
  });

  it("a wrong code never downgrades an already-verified call", async () => {
    const env = rfEnv();
    const { me, s } = await started(env);
    await handleRadioMessage(env, heard("OE8APR-7", `VERIFY ${s.data.code}`));
    expect(await verified(env, "OE8APR")).toBe(true);
    await call(env, "POST", "/verify/aprs/start", { callsign: "OE8APR" }, { cookie: me.cookie });
    for (let i = 0; i < 6; i++)
      await handleRadioMessage(env, heard("OE8APR-7", "VERIFY 000000", { msgNo: String(10 + i) }));
    expect(await verified(env, "OE8APR")).toBe(true);
    expect((await held(env, "OE8APR"))!.verified).toBe(1);
  });

  it("an expired challenge does not verify, and a used code does not replay", async () => {
    const env = rfEnv();
    const { s } = await started(env);
    await env.DB.prepare("UPDATE callsign_verifications SET created_at = created_at - 7200").run();
    await handleRadioMessage(env, heard("OE8APR-7", `VERIFY ${s.data.code}`));
    expect(await verified(env, "OE8APR")).toBe(false);

    const env2 = rfEnv();
    const b = await started(env2);
    await handleRadioMessage(env2, heard("OE8APR-7", `VERIFY ${b.s.data.code}`));
    await env2.DB.prepare("UPDATE callsign_verifications SET status='pending'").run();
    await handleRadioMessage(env2, heard("OE8APR-7", `VERIFY ${b.s.data.code}`, { msgNo: "77" }));
    expect((await row(env2, "OE8APR"))!.status).toBe("pending");
  });

  it("the rf helper verifies end to end", async () => {
    const env = rfEnv();
    const me = await emailSignup(env, "owner@example.test", "OE8APR");
    await rfVerify(env, me.cookie, "OE8APR");
    expect(await verified(env, "OE8APR")).toBe(true);
  });
});

describe("a VERIFY message sent from a MeshCom node", () => {
  // The packets the ingest's MeshCom listener emits (apps/ingest/test/meshcom.test.ts) for a direct
  // message to the service call, heard by the operator's node OE8XXX-12 — an attested site here.
  const NODE = "OE8XXX-12";
  const meshEnv = () => authEnv({ FIRST_PARTY_SITES: NODE });
  const meshcom = (code: string, o: Record<string, unknown> = {}) => ({
    src: "OE8APR-1",
    dst: "APRS",
    path: [] as string[],
    payload: `:APRSCG   :VERIFY ${code}{012`,
    kind: "message",
    heardVia: "rf",
    igateCall: NODE,
    port: "meshcom",
    rxCall: NODE,
    ts: Math.floor(Date.now() / 1000),
    ...o,
  });
  const ingest = (env: Env, packet: Record<string, unknown>) =>
    call(env, "POST", "/ingest", { packets: [packet] }, SECRET);

  it("verifies when the attested node heard it directly over LoRa", async () => {
    const env = meshEnv();
    const { s } = await started(env);
    expect((await ingest(env, meshcom(s.data.code))).status).toBe(200);
    expect(await verified(env, "OE8APR")).toBe(true);
    expect(await row(env, "OE8APR")).toMatchObject({ method: "rf_heard", verified_by: NODE });
  });

  it.each([
    ["relayed over the mesh", { path: ["OE1XYZ-12"], igateCall: undefined }],
    ["from the MeshCom server", { heardVia: "aprs_is", igateCall: undefined }],
    ["heard by a node that is not attested", { igateCall: "OE9ZZZ-12", rxCall: "OE9ZZZ-12" }],
  ])("does not verify when it arrives %s, and costs no attempt", async (_label, o) => {
    const env = meshEnv();
    const { s } = await started(env);
    await ingest(env, meshcom(s.data.code, o));
    expect(await verified(env, "OE8APR")).toBe(false);
    expect((await row(env, "OE8APR"))!.attempts).toBe(0);
    await ingest(env, meshcom(s.data.code, { ts: Math.floor(Date.now() / 1000) + 1 }));
    expect(await verified(env, "OE8APR")).toBe(true);
  });
});

describe("operator bootstrap", () => {
  it("needs the operator secret and an ADMIN_CALLSIGNS call", async () => {
    const env = rfEnv({ ADMIN_CALLSIGNS: "OE8APR" });
    const s = await emailSignup(env, "op@example.test", "OE8APR");
    expect((await call(env, "POST", "/verify/operator", { callsign: "OE8APR" })).status).toBe(401);
    expect(
      (await call(env, "POST", "/verify/operator", { callsign: "OE8APR" }, { "x-operator-secret": "wrong" })).status,
    ).toBe(401);
    // the ingest secret sits on the ingest box and is not an operator credential
    expect((await call(env, "POST", "/verify/operator", { callsign: "OE8APR" }, SECRET)).status).toBe(401);
    expect((await call(env, "POST", "/verify/operator", { callsign: "DL1AAA" }, OPERATOR)).status).toBe(403);
    expect((await call(env, "POST", "/verify/operator", { callsign: "OE8APR" }, { cookie: s.cookie })).status).toBe(
      401,
    );
    const ok = await call(env, "POST", "/verify/operator", { callsign: "OE8APR" }, OPERATOR);
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({ verified: true, callsign: "OE8APR", method: "operator" });
    expect(await row(env, "OE8APR")).toMatchObject({ status: "verified", method: "operator" });
    expect(await held(env, "OE8APR")).toEqual({ verified: 1, method: "operator" });
    const who = await call(env, "GET", "/api/admin/whoami", undefined, { cookie: s.cookie });
    expect(who.data.sysop).toBe(true);
  });

  it("verifies the call even before any account holds it", async () => {
    const env = rfEnv({ ADMIN_CALLSIGNS: "OE8APR" });
    await operatorVerify(env, "OE8APR");
    expect(await verified(env, "OE8APR")).toBe(true);
  });
});

describe("whoami pending hint", () => {
  it("tells only the unverified holder of an ADMIN_CALLSIGNS call to verify", async () => {
    const env = rfEnv({ ADMIN_CALLSIGNS: "OE8APR" });
    const op = await emailSignup(env, "op@example.test", "OE8APR");
    const who = await call(env, "GET", "/api/admin/whoami", undefined, { cookie: op.cookie });
    expect(who.data).toMatchObject({ sysop: false, pending: "verify" });
    const other = await emailSignup(env, "other@example.test", "DL1AAA");
    const whoOther = await call(env, "GET", "/api/admin/whoami", undefined, { cookie: other.cookie });
    expect(whoOther.data.pending).toBeUndefined();
    expect((await call(env, "GET", "/api/admin/whoami")).data.pending).toBeUndefined();
    await operatorVerify(env, "OE8APR");
    const after = await call(env, "GET", "/api/admin/whoami", undefined, { cookie: op.cookie });
    expect(after.data.sysop).toBe(true);
    expect(after.data.pending).toBeUndefined();
  });
});

describe("sysop manual verification", () => {
  async function sysopEnv() {
    const env = rfEnv({ ADMIN_CALLSIGNS: "OE8APR" });
    const op = await emailSignup(env, "op@example.test", "OE8APR");
    await operatorVerify(env, "OE8APR");
    const user = await emailSignup(env, "far@example.test", "VK2FAR");
    return { env, op, user };
  }

  it("is sysop-only: a normal user and an anonymous caller cannot verify, list or revoke", async () => {
    const { env, user } = await sysopEnv();
    const body = { callsign: "VK2FAR", note: "checked the licence by video call" };
    expect((await call(env, "POST", "/api/admin/verifications", body, { cookie: user.cookie })).status).toBe(403);
    expect((await call(env, "POST", "/api/admin/verifications", body)).status).toBe(403);
    expect((await call(env, "POST", "/api/admin/verifications", body, SECRET)).status).toBe(403);
    expect((await call(env, "GET", "/api/admin/verifications", undefined, { cookie: user.cookie })).status).toBe(403);
    expect(
      (await call(env, "DELETE", "/api/admin/verifications/VK2FAR", undefined, { cookie: user.cookie })).status,
    ).toBe(403);
    expect(await verified(env, "VK2FAR")).toBe(false);
  });

  it("verifies with a required note, records who and when, lists it, and revokes it", async () => {
    const { env, op } = await sysopEnv();
    const noNote = await call(env, "POST", "/api/admin/verifications", { callsign: "VK2FAR" }, { cookie: op.cookie });
    expect(noNote.status).toBe(400);
    const body = { callsign: "vk2far-7", note: "checked the licence by video call" };
    // without naming the holding account the sysop checked, nothing is verified and the holder is shown
    const unconfirmed = await call(env, "POST", "/api/admin/verifications", body, { cookie: op.cookie });
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.data).toMatchObject({ reason: "confirm_holder", holder: { activeCallsign: "VK2FAR" } });
    const wrong = await call(
      env,
      "POST",
      "/api/admin/verifications",
      { ...body, holder: "someone-else" },
      {
        cookie: op.cookie,
      },
    );
    expect(wrong.status).toBe(409);
    expect(await verified(env, "VK2FAR")).toBe(false);
    const add = await call(
      env,
      "POST",
      "/api/admin/verifications",
      { ...body, holder: unconfirmed.data.holder.accountId },
      { cookie: op.cookie },
    );
    expect(add.status).toBe(201);
    expect(await verified(env, "VK2FAR")).toBe(true);
    expect(await row(env, "VK2FAR")).toMatchObject({
      method: "sysop",
      verified_by: "OE8APR",
      note: "checked the licence by video call",
    });
    expect(await held(env, "VK2FAR")).toEqual({ verified: 1, method: "sysop" });
    const ev = await env.DB.prepare("SELECT action, detail FROM account_events WHERE callsign='VK2FAR'").all<{
      action: string;
      detail: string;
    }>();
    expect(ev.results.map((e) => e.action)).toContain("sysop_verified");

    const list = await call(env, "GET", "/api/admin/verifications", undefined, { cookie: op.cookie });
    expect(list.status).toBe(200);
    expect(list.data.verifications).toEqual([
      expect.objectContaining({ callsign: "VK2FAR", verifiedBy: "OE8APR", note: "checked the licence by video call" }),
    ]);

    const rev = await call(env, "DELETE", "/api/admin/verifications/VK2FAR", undefined, { cookie: op.cookie });
    expect(rev.status).toBe(200);
    expect(await verified(env, "VK2FAR")).toBe(false);
    expect((await held(env, "VK2FAR"))!.verified).toBe(0);
    const ev2 = await env.DB.prepare("SELECT action FROM account_events WHERE callsign='VK2FAR'").all<{
      action: string;
    }>();
    expect(ev2.results.map((e) => e.action)).toContain("sysop_revoked");
    expect(
      (await call(env, "GET", "/api/admin/verifications", undefined, { cookie: op.cookie })).data.verifications,
    ).toEqual([]);
  });

  it("revoke touches only sysop verifications, and a call verified another way is not overwritten", async () => {
    const { env, op } = await sysopEnv();
    expect(
      (await call(env, "DELETE", "/api/admin/verifications/OE8APR", undefined, { cookie: op.cookie })).status,
    ).toBe(404);
    expect(await verified(env, "OE8APR")).toBe(true);
    const again = await call(
      env,
      "POST",
      "/api/admin/verifications",
      { callsign: "OE8APR", note: "should not replace the operator record" },
      { cookie: op.cookie },
    );
    expect(again.status).toBe(409);
    expect(await row(env, "OE8APR")).toMatchObject({ method: "operator" });
  });
});
