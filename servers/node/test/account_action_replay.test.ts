// SPDX-License-Identifier: AGPL-3.0-or-later
// A device-key signature on an account route authorises one request: it signs the route's action and the
// digest of the request's parameters, and the same signature is refused a second time.
import { describe, it, expect } from "vitest";
import { accountActionDigest, accountActionMessage } from "@aprscaching/shared";
import type { Env } from "@aprscaching/gateway/env";
import { authEnv, call, emailSignup } from "./helpers/authflow.js";
import { newFedKey, type FedKey } from "./helpers/fedpeer.js";

const nowS = () => Math.floor(Date.now() / 1000);

async function setup(): Promise<{ env: Env; dev: FedKey }> {
  const env = authEnv({ INSTANCE: "gw.test" });
  expect((await emailSignup(env, "mover@example.test", "OE7SIG")).status).toBe(200);
  const dev = await newFedKey();
  await env.DB.prepare("INSERT INTO callsign_keys (callsign, public_key, label, created_at) VALUES (?,?,?,1)")
    .bind("OE7SIG", dev.pub, "phone")
    .run();
  return { env, dev };
}

async function signed(dev: FedKey, action: string, params: Record<string, unknown>) {
  const at = nowS();
  const msg = accountActionMessage({
    action,
    callsign: "OE7SIG",
    instance: "gw.test",
    at,
    digest: await accountActionDigest(params),
  });
  const sig = Buffer.from(await crypto.subtle.sign("Ed25519", dev.priv, new TextEncoder().encode(msg))).toString(
    "base64url",
  );
  return { ...params, key: dev.pub, sig, at };
}

describe("a signed account action authorises one request", () => {
  it("an export signature works once; the same request again is refused", async () => {
    const { env, dev } = await setup();
    const body = await signed(dev, "export", {});
    expect((await call(env, "POST", "/api/account/OE7SIG/export", body)).status).toBe(200);
    const again = await call(env, "POST", "/api/account/OE7SIG/export", body);
    expect(again.status).toBe(401);
  });

  it("a move's target is signed: the signature does not carry another target", async () => {
    const { env, dev } = await setup();
    const body = await signed(dev, "move", { target: "good.example" });
    const swapped = await call(env, "POST", "/api/account/OE7SIG/move", { ...body, target: "evil.example" });
    expect(swapped.status).toBe(401);
    const ok = await call(env, "POST", "/api/account/OE7SIG/move", body);
    expect(ok.status).toBe(200);
    expect(ok.data.movedTo).toBe("good.example");
  });

  it("a bundle signature does not authorise a move, nor an export an erasure", async () => {
    const { env, dev } = await setup();
    const bundle = await signed(dev, "bundle", { target: "evil.example" });
    expect((await call(env, "POST", "/api/account/OE7SIG/move", bundle)).status).toBe(401);
    const exp = await signed(dev, "export", {});
    expect((await call(env, "POST", "/api/account/OE7SIG/delete", exp)).status).toBe(401);
    const left = await env.DB.prepare("SELECT 1 FROM accounts WHERE callsign = 'OE7SIG'").first();
    expect(left).not.toBeNull();
  });
});
