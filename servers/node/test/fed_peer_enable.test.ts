// SPDX-License-Identifier: AGPL-3.0-or-later
// A discovered peer starts disabled. Choosing a level for it in Instance admin is the operator enabling it, so
// "Enable" there sets it unvetted and the peer syncs; blocking it keeps it disabled.
import { describe, it, expect } from "vitest";
import { authEnv, call } from "./helpers/authflow.js";

const OPERATOR = { "x-operator-secret": "test-operator-secret" };

async function discovered(url: string) {
  const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR" });
  await env.DB.prepare(
    "INSERT INTO fed_peers (url, instance, trust, added_via, enabled) VALUES (?, ?, 'unvetted', 'discovered', 0)",
  )
    .bind(url, new URL(url).host)
    .run();
  return env;
}

async function peerRow(env: Awaited<ReturnType<typeof discovered>>, url: string) {
  const list = await call(env, "GET", "/federation/peers", undefined, OPERATOR);
  expect(list.status).toBe(200);
  return (list.data.peers as { url: string; enabled: number; trust: string }[]).find((p) => p.url === url);
}

describe("enabling a discovered federation peer", () => {
  it("lists the peer as disabled, and setting it unvetted enables it", async () => {
    const url = "https://found.example";
    const env = await discovered(url);
    expect(Number((await peerRow(env, url))?.enabled)).toBe(0);
    const r = await call(env, "POST", "/federation/peers/trust", { url, trust: "unvetted" }, OPERATOR);
    expect(r.status).toBe(200);
    const row = await peerRow(env, url);
    expect(Number(row?.enabled)).toBe(1);
    expect(row?.trust).toBe("unvetted");
  });

  it("blocking a discovered peer leaves it disabled", async () => {
    const url = "https://shady.example";
    const env = await discovered(url);
    await call(env, "POST", "/federation/peers/trust", { url, trust: "blocked" }, OPERATOR);
    expect(Number((await peerRow(env, url))?.enabled)).toBe(0);
  });
});
