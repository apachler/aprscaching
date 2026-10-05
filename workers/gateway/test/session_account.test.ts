// SPDX-License-Identifier: AGPL-3.0-or-later
// One canonical account resolver. A session names its account and that account's session generation;
// it resolves only while the account exists at that generation and holds the base of the session's call
// (so an SSID maps to the same account). Every caller uses it directly.
import { describe, it, expect } from "vitest";
import { sessionIdentity } from "../src/auth.js";
import type { Env } from "../src/env.js";
import { sessionDb, sessionRequest } from "./sessiondb.js";

const SESSION_SECRET = "strong-session-secret-xyz";
const envFor = (acct: { accountId: string; base: string; gen?: number }) =>
  ({ SESSION_SECRET, DB: sessionDb(acct) }) as unknown as Env;

describe("sessionIdentity — one canonical resolver", () => {
  it("resolves an SSID session to the account holding its BASE call", async () => {
    const env = envFor({ accountId: "acct-123", base: "OE8APR" });
    const me = await sessionIdentity(await sessionRequest(env, "acct-123", "OE8APR-7"), env);
    expect(me).toEqual({ accountId: "acct-123", callsign: "OE8APR-7", base: "OE8APR", origin: expect.any(String) });
  });

  it("resolves to nobody once another account holds the call", async () => {
    const env = envFor({ accountId: "acct-123", base: "OE8APR" });
    const req = await sessionRequest(env, "acct-123", "OE8APR");
    const later = { SESSION_SECRET, DB: sessionDb({ accountId: "acct-other", base: "OE8APR" }) } as unknown as Env;
    expect(await sessionIdentity(req, later)).toBeNull();
  });

  it("resolves to nobody after the account moves to a newer session generation", async () => {
    const env = envFor({ accountId: "acct-123", base: "OE8APR", gen: 0 });
    const req = await sessionRequest(env, "acct-123", "OE8APR");
    expect(await sessionIdentity(req, envFor({ accountId: "acct-123", base: "OE8APR", gen: 1 }))).toBeNull();
  });

  it("resolves to nobody on another address than the one it was issued on", async () => {
    const env = envFor({ accountId: "acct-123", base: "OE8APR" });
    const req = await sessionRequest(env, "acct-123", "OE8APR", "http://gw/api/whoami");
    const cookie = req.headers.get("cookie")!;
    expect(await sessionIdentity(new Request("http://gw/x", { headers: { cookie } }), env)).not.toBeNull();
    expect(await sessionIdentity(new Request("https://gw/x", { headers: { cookie } }), env)).toBeNull();
    expect(await sessionIdentity(new Request("http://other/x", { headers: { cookie } }), env)).toBeNull();
  });

  it("returns null when signed out", async () => {
    const env = envFor({ accountId: "acct-123", base: "OE8APR" });
    const req = new Request("http://gw/api/whoami"); // no cookie
    expect(await sessionIdentity(req, env)).toBeNull();
  });
});
