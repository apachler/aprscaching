// SPDX-License-Identifier: AGPL-3.0-or-later
// The shared INGEST_SECRET authorises ingest-plane writes only. It never verifies a callsign: whoever holds
// it can type any frame, so a VERIFY it delivers is dropped, and only a box enrolled with its own key, heard at
// a site trusted through that box, proves control of a call. Nor does it act for a box enrolled with its own
// key: that box's pairing, polling, acks, queue and log take only its signature, with the operator secret as
// the operator's override. A box with no key keeps working on the shared secret.
import { describe, it, expect } from "vitest";
import type { Env } from "@aprscaching/gateway/env";
import { authEnv, call, emailSignup } from "./helpers/authflow.js";
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

describe("a box enrolled with its own key", () => {
  /** Every /api/box/:id endpoint the box or its operator calls, with `send` supplying the credential. */
  const endpoints = (id: string) =>
    [
      ["POST", `/api/box/${id}/pair`, {}],
      ["GET", `/api/box/${id}/commands`, undefined],
      ["POST", `/api/box/${id}/commands/ack`, { id: 1, status: "done" }],
      ["POST", `/api/box/${id}/command`, { kind: "status" }],
      ["GET", `/api/box/${id}/log`, undefined],
    ] as const;

  it("is not paired, polled, acked, queued or read by the shared secret", async () => {
    const env = authEnv({ ROOMS });
    await enrollBox(env, "keyed-1");
    for (const [m, p, b] of endpoints("keyed-1")) {
      const r = await call(env, m, p, b, INGEST);
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(r.data?.error).toMatch(/own key/);
    }
    expect(await env.DB.prepare("SELECT 1 AS x FROM box_pairings WHERE box_id = 'keyed-1'").first()).toBeNull();
  });

  it("takes its own signature, and the operator secret as the override", async () => {
    const env = authEnv({ ROOMS });
    const k = await enrollBox(env, "keyed-1");
    for (const [m, p, b] of endpoints("keyed-1")) {
      expect((await signedCall(env, k, m, p, b)).status, `signed ${m} ${p}`).toBeLessThan(300);
      expect((await call(env, m, p, b, OPS)).status, `operator ${m} ${p}`).toBeLessThan(300);
    }
  });

  it("keeps its owner: a code the shared secret cannot mint, nobody can claim", async () => {
    const env = authEnv({ ROOMS });
    const k = await enrollBox(env, "keyed-1");
    const pair = await signedCall(env, k, "POST", "/api/box/keyed-1/pair", {});
    expect(pair.status).toBe(200);
    const intruder = await emailSignup(env, "intruder@example.test", "DL9BAD");
    expect((await call(env, "POST", "/api/box/keyed-1/pair", {}, { ...INGEST, cookie: intruder.cookie })).status).toBe(
      403,
    );
    const owner = await emailSignup(env, "owner@example.test", "DL1OWN");
    const claimed = await call(
      env,
      "POST",
      "/api/box/keyed-1/claim",
      { code: pair.data.code },
      { cookie: owner.cookie },
    );
    expect(claimed.status).toBe(200);
  });
});

describe("a box with no key of its own", () => {
  it("is paired, polled and acked on the shared secret", async () => {
    const env = authEnv({ ROOMS });
    expect((await call(env, "POST", "/api/box/pi-home/pair", {}, INGEST)).status).toBe(200);
    expect((await call(env, "GET", "/api/box/pi-home/commands", undefined, INGEST)).status).toBe(200);
    expect((await call(env, "POST", "/api/box/pi-home/command", { kind: "status" }, INGEST)).status).toBe(201);
  });
});
