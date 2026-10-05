// SPDX-License-Identifier: AGPL-3.0-or-later
// A suspension outlives the erasure of its account: erasure removes the account and everything tied to it, and
// leaves on each base call it held only the call, the reason category and the end. Until the suspension ends or
// the sysop lifts it, no registration, addition, switch or claim takes the call.
import { describe, it, expect } from "vitest";
import { accountActionMessage } from "@aprscaching/shared";
import { runScheduled } from "@aprscaching/gateway/app";
import { authEnv, call, emailSignup, operatorVerify, type Res } from "./helpers/authflow.js";
import { newFedKey } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

let ipSeq = 0;
const nextIp = () => `198.51.100.${++ipSeq % 250}`;
const nowS = () => Math.floor(Date.now() / 1000);

async function world(): Promise<{ env: Env; sysop: Res }> {
  const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR" });
  const sysop = await emailSignup(env, "op@example.test", "OE8APR", nextIp());
  await operatorVerify(env, "OE8APR");
  return { env, sysop };
}
const user = (env: Env, cs: string) => emailSignup(env, `${cs.toLowerCase()}@example.test`, cs, nextIp());
const sysopCall = (w: { env: Env; sysop: Res }, method: string, path: string, body?: unknown) =>
  call(w.env, method, `/api/admin/moderation${path}`, body, { cookie: w.sysop.cookie });

/** Erase an account by a request signed with a device key registered to its call, as a suspended person can. */
async function signedErase(env: Env, cs: string) {
  const dev = await newFedKey();
  await env.DB.prepare("INSERT INTO callsign_keys (callsign, public_key, label, created_at) VALUES (?,?,?,1)")
    .bind(cs, dev.pub, "phone")
    .run();
  const at = nowS();
  const msg = new TextEncoder().encode(
    accountActionMessage({ action: "delete", callsign: cs, instance: "gw.test", at }),
  );
  const sig = Buffer.from(await crypto.subtle.sign("Ed25519", dev.priv, msg)).toString("base64url");
  return call(env, "POST", `/api/account/${cs}/delete`, { key: dev.pub, sig, at });
}

const count = async (env: Env, table: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

describe("a suspension outlives the erasure of its account", () => {
  it("keeps only the call, the category and the end, and refuses the call to anyone until it is lifted", async () => {
    const w = await world();
    const bad = await user(w.env, "DL1BAD");
    expect((await call(w.env, "POST", "/auth/callsigns", { callsign: "DL2BAD" }, { cookie: bad.cookie })).status).toBe(
      200,
    );
    const s = await sysopCall(w, "POST", "/accounts/DL1BAD/suspend", {
      reason: "harassed others",
      category: "offensive",
    });
    expect(s.status).toBe(200);
    expect((await signedErase(w.env, "DL1BAD")).status).toBe(200);
    expect(await count(w.env, "account_suspensions")).toBe(0);
    // the record names no account and carries no free text
    const rows = (
      await w.env.DB.prepare("SELECT * FROM callsign_suspensions ORDER BY callsign").all<Record<string, unknown>>()
    ).results;
    expect(rows.map((r) => Object.keys(r).sort())).toEqual([
      ["at", "callsign", "category", "until"],
      ["at", "callsign", "category", "until"],
    ]);
    expect(rows.map((r) => [r.callsign, r.category, r.until])).toEqual([
      ["DL1BAD", "offensive", null],
      ["DL2BAD", "offensive", null],
    ]);

    // a new registration, an addition to another account, a switch and a claim are all refused
    const again = await emailSignup(w.env, "fresh@example.test", "DL1BAD", nextIp());
    expect(again.status).toBe(403);
    expect(again.data).toMatchObject({
      error: "this callsign is suspended on this instance: offensive",
      reason: "suspended",
    });
    expect(again.cookie).toBe("");
    const other = await user(w.env, "DL1OTH");
    const add = await call(w.env, "POST", "/auth/callsigns", { callsign: "DL2BAD" }, { cookie: other.cookie });
    expect(add.status).toBe(403);
    expect(add.data.reason).toBe("suspended");
    expect((await call(w.env, "POST", "/auth/callsign", { callsign: "DL2BAD" }, { cookie: other.cookie })).status).toBe(
      403,
    );
    const claim = await call(w.env, "POST", "/auth/claims", { callsign: "DL1BAD" }, {}, nextIp());
    expect(claim.status).toBe(403);
    expect(claim.data.reason).toBe("suspended");
    // the table itself refuses the call, whichever path asks
    await expect(
      w.env.DB.prepare(
        "INSERT INTO account_callsigns (account_id, callsign, is_primary, added_at) VALUES ('x', 'DL1BAD', 1, 1)",
      ).run(),
    ).rejects.toThrow(/callsign suspended/);

    // the sysop sees it in the suspended list and lifts it
    const list = await sysopCall(w, "GET", "/accounts?suspended=1");
    expect(list.data.erasedCalls.map((c: { callsign: string }) => c.callsign).sort()).toEqual(["DL1BAD", "DL2BAD"]);
    expect((await sysopCall(w, "POST", "/accounts/DL1BAD/unsuspend", { reason: "appeal accepted" })).status).toBe(200);
    expect((await sysopCall(w, "POST", "/accounts/DL1BAD/unsuspend", { reason: "again" })).status).toBe(409);
    expect((await emailSignup(w.env, "fresh@example.test", "DL1BAD", nextIp())).status).toBe(200);
    const audit = (
      await w.env.DB.prepare("SELECT action, target_kind FROM moderation_log ORDER BY id").all<{
        action: string;
        target_kind: string;
      }>()
    ).results;
    expect(audit).toContainEqual({ action: "unsuspend", target_kind: "callsign" });
  });

  it("ends with a dated suspension, and the nightly prune drops the record", async () => {
    const w = await world();
    await user(w.env, "DL1TMP");
    const until = nowS() + 3600;
    await sysopCall(w, "POST", "/accounts/DL1TMP/suspend", { reason: "cool down", category: "spam", until });
    expect((await signedErase(w.env, "DL1TMP")).status).toBe(200);
    const refused = await emailSignup(w.env, "new@example.test", "DL1TMP", nextIp());
    expect(refused.data.error).toMatch(/^this callsign is suspended on this instance until \d{4}-\d{2}-\d{2}: spam$/);
    await w.env.DB.prepare("UPDATE callsign_suspensions SET until=?")
      .bind(nowS() - 1)
      .run();
    await runScheduled(w.env);
    expect(await count(w.env, "callsign_suspensions")).toBe(0);
    expect((await emailSignup(w.env, "new@example.test", "DL1TMP", nextIp())).status).toBe(200);
  });

  it("leaves nothing behind when the account was not suspended", async () => {
    const w = await world();
    await user(w.env, "DL1OK");
    expect((await signedErase(w.env, "DL1OK")).status).toBe(200);
    expect(await count(w.env, "callsign_suspensions")).toBe(0);
  });

  it("needs a category to suspend", async () => {
    const w = await world();
    await user(w.env, "DL1CAT");
    expect((await sysopCall(w, "POST", "/accounts/DL1CAT/suspend", { reason: "abuse" })).status).toBe(400);
    expect((await sysopCall(w, "POST", "/accounts/DL1CAT/suspend", { reason: "abuse", category: "rude" })).status).toBe(
      400,
    );
  });
});
