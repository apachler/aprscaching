// SPDX-License-Identifier: AGPL-3.0-or-later
// Callsign control-verification with an ARRL Logbook of The World callsign certificate. The browser
// signs the server's challenge with the certificate's private key and sends only the certificate chain
// and the signature; the gateway checks the signature, the chain up to a LoTW CA the operator trusts
// (LOTW_CA_PEM), the validity dates, and that the certificate's callsign is the base call.
// All certificates here are SYNTHETIC (workers/gateway/test/fixtures/lotw/gen.sh), not ARRL's.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Env } from "@aprscaching/gateway/env";
import { authEnv, call, emailSignup } from "./helpers/authflow.js";

const FX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../workers/gateway/test/fixtures/lotw");
const pem = (f: string) => readFileSync(path.join(FX, f), "utf8");
const b64 = (p: string) => p.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
const chain = (leaf: string) => [b64(pem(leaf)), b64(pem("ca.pem")), b64(pem("root.pem"))];

const lotwEnv = (extra: Record<string, unknown> = {}) => authEnv({ LOTW_CA_PEM: pem("root.pem"), ...extra });

async function userKey(): Promise<CryptoKey> {
  const der = readFileSync(path.join(FX, "user.key.der"));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}
async function sign(message: string): Promise<string> {
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", await userKey(), new TextEncoder().encode(message));
  return Buffer.from(sig).toString("base64");
}

async function started(env: Env, cs = "OE8APR") {
  const me = await emailSignup(env, `${cs.toLowerCase()}@example.test`, cs);
  const s = await call(env, "POST", "/verify/lotw/start", { callsign: cs }, { cookie: me.cookie });
  return { me, s };
}
const complete = (env: Env, cookie: string, body: Record<string, unknown>, cs = "OE8APR") =>
  call(env, "POST", "/verify/lotw/complete", { callsign: cs, ...body }, { cookie });
const verified = async (env: Env, cs: string) =>
  (await call(env, "GET", `/verify/aprs/status?callsign=${cs}`)).data?.verified === true;

describe("LoTW certificate verification", () => {
  it("issues a challenge naming the exact message to sign", async () => {
    const env = lotwEnv();
    const { s } = await started(env);
    expect(s.status).toBe(200);
    expect(s.data.message).toBe(`aprscaching-lotw-verify:v1:OE8APR:${s.data.challenge}`);
    expect(s.data.algorithm).toBe("RSASSA-PKCS1-v1_5/SHA-256");
    expect(s.data.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("is unavailable until the operator configures the trusted LoTW CA certificates", async () => {
    const env = authEnv();
    const { s } = await started(env);
    expect(s.status).toBe(503);
    expect((await call(env, "GET", "/verify/methods")).data.methods).toMatchObject({ lotw: false, ampr_dns: true });
    expect((await call(lotwEnv(), "GET", "/verify/methods")).data.methods).toMatchObject({ lotw: true });
  });

  it("verifies a signed challenge from a current certificate for the call", async () => {
    const env = lotwEnv();
    const { me, s } = await started(env);
    const r = await complete(env, me.cookie, {
      certificates: chain("user-oe8apr.pem"),
      signature: await sign(s.data.message),
    });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ verified: true, callsign: "OE8APR", method: "lotw" });
    expect(await verified(env, "OE8APR")).toBe(true);
    const row = await env.DB.prepare(
      "SELECT method, verified_by, note FROM callsign_verifications WHERE callsign='OE8APR'",
    ).first<{ method: string; verified_by: string; note: string }>();
    expect(row).toMatchObject({ method: "lotw", verified_by: "Synthetic Test LoTW Root" });
    expect(row!.note).toMatch(/serial/);
    // the held call reads as verified through the one store
    const held = await env.DB.prepare(
      "SELECT ac.callsign, v.method FROM account_callsigns ac JOIN callsign_verifications v ON v.callsign = ac.callsign AND v.status = 'verified' WHERE ac.callsign='OE8APR'",
    ).first();
    expect(held).toEqual({ callsign: "OE8APR", method: "lotw" });
    // the challenge is spent: a replay does not verify again
    expect(
      (
        await complete(env, me.cookie, {
          certificates: chain("user-oe8apr.pem"),
          signature: await sign(s.data.message),
        })
      ).status,
    ).toBe(409);
  });

  it.each([
    ["a certificate for another call", { leaf: "user-dl1aaa.pem" }],
    ["an expired certificate", { leaf: "user-expired.pem" }],
    [
      "a certificate under an untrusted root",
      { certs: () => [b64(pem("user-rogue.pem")), b64(pem("rogue-root.pem"))] },
    ],
    ["a signature over another message", { message: "aprscaching-lotw-verify:v1:OE8APR:not-the-challenge" }],
  ])("refuses %s", async (_label, o: { leaf?: string; certs?: () => string[]; message?: string }) => {
    const env = lotwEnv();
    const { me, s } = await started(env);
    const r = await complete(env, me.cookie, {
      certificates: o.certs ? o.certs() : chain(o.leaf ?? "user-oe8apr.pem"),
      signature: await sign(o.message ?? s.data.message),
    });
    expect(r.status).toBe(422);
    expect(typeof r.data.error).toBe("string");
    expect(await verified(env, "OE8APR")).toBe(false);
  });

  it("needs the holder's session and its own outstanding challenge", async () => {
    const env = lotwEnv();
    const { s } = await started(env);
    const other = await emailSignup(env, "other@example.test", "DL1AAA");
    const body = { callsign: "OE8APR", certificates: chain("user-oe8apr.pem"), signature: await sign(s.data.message) };
    expect((await call(env, "POST", "/verify/lotw/complete", body)).status).toBe(401);
    expect((await call(env, "POST", "/verify/lotw/complete", body, { cookie: other.cookie })).status).toBe(403);
  });

  it("locks the challenge after repeated failures, and refuses oversized input", async () => {
    const env = lotwEnv();
    const { me, s } = await started(env);
    const bad = { certificates: chain("user-oe8apr.pem"), signature: await sign("wrong") };
    for (let i = 0; i < 5; i++) expect((await complete(env, me.cookie, bad)).status).toBe(422);
    const good = { certificates: chain("user-oe8apr.pem"), signature: await sign(s.data.message) };
    expect((await complete(env, me.cookie, good)).status).toBe(409);
    expect(await verified(env, "OE8APR")).toBe(false);

    const env2 = lotwEnv();
    const b = await started(env2);
    const many = Array.from({ length: 20 }, () => b64(pem("ca.pem")));
    expect((await complete(env2, b.me.cookie, { certificates: many, signature: "x" })).status).toBe(400);
  });
});
