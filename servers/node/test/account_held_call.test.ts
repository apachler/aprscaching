// SPDX-License-Identifier: AGPL-3.0-or-later
// Every account holds its base call in `account_callsigns`, whatever created it, so that table alone
// answers "who holds this licence". An account imported from another instance holds its call from the
// moment it lands: nobody can open a second account on an SSID of it, and an import cannot take a base
// call another account already holds.
import { describe, it, expect } from "vitest";
import { accountActionMessage } from "@aprscaching/shared";
import { authEnv, call, emailSignup } from "./helpers/authflow.js";
import { newFedKey } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

const nowS = () => Math.floor(Date.now() / 1000);

async function importAccount(env: Env, callsign: string) {
  const dev = await newFedKey();
  const at = nowS();
  const msg = new TextEncoder().encode(accountActionMessage({ action: "migrate", callsign, instance: "gw.test", at }));
  const sig = Buffer.from(await crypto.subtle.sign("Ed25519", dev.priv, msg)).toString("base64url");
  return call(env, "POST", "/api/account/import", {
    bundle: { v: 1, instance: "oe.origin", callsign, keys: [{ publicKey: dev.pub }], at },
    assertion: { key: dev.pub, sig, at },
  });
}

describe("an imported account holds its base call", () => {
  it("lands with a held, unverified base call that blocks an SSID sign-up", async () => {
    const env = authEnv();
    const imp = await importAccount(env, "OE7MOV-2");
    expect(imp.status).toBe(200);
    const held = await env.DB.prepare(
      "SELECT ac.callsign, ac.is_primary FROM account_callsigns ac JOIN accounts a ON a.account_id = ac.account_id WHERE a.callsign = 'OE7MOV-2'",
    ).all();
    expect(held.results).toEqual([{ callsign: "OE7MOV", is_primary: 1 }]);
    expect((await call(env, "GET", "/verify/aprs/status?callsign=OE7MOV")).data.verified).toBe(false);
    const squat = await call(env, "POST", "/auth/email/start", { email: "evil@example.test", callsign: "OE7MOV-9" });
    expect(squat.status).toBe(409);
  });

  it("is refused when another account already holds the base call", async () => {
    const env = authEnv();
    expect((await emailSignup(env, "holder@example.test", "OE7MOV")).status).toBe(200);
    const imp = await importAccount(env, "OE7MOV-3");
    expect(imp.status).toBe(409);
    const stray = await env.DB.prepare("SELECT 1 AS x FROM accounts WHERE callsign = 'OE7MOV-3'").first();
    expect(stray).toBeNull();
  });
});
