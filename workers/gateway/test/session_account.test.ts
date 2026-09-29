// SPDX-License-Identifier: AGPL-3.0-or-later
// One canonical account resolver. A session names its account and that account's session generation;
// it resolves only while the account exists at that generation and holds the base of the session's call
// (so an SSID maps to the same account). auth.ts owns the logic; watch.ts re-exports a bare-string
// wrapper. This pins both to the same answer.
import { describe, it, expect } from "vitest";
import { sessionAccountId, sessionIdentity } from "../src/auth.js";
import { sessionAccountId as watchAccountId } from "../src/watch.js";
import type { Env } from "../src/env.js";
import { sessionDb, sessionRequest } from "./sessiondb.js";

const SESSION_SECRET = "strong-session-secret-xyz";
const envFor = (acct: { accountId: string; base: string; gen?: number }) =>
  ({ SESSION_SECRET, DB: sessionDb(acct) }) as unknown as Env;

describe("sessionIdentity — one canonical resolver", () => {
  it("resolves an SSID session to the account holding its BASE call", async () => {
    const env = envFor({ accountId: "acct-123", base: "OE8APR" });
    const me = await sessionIdentity(await sessionRequest(env, "acct-123", "OE8APR-7"), env);
    expect(me).toEqual({ accountId: "acct-123", callsign: "OE8APR-7", base: "OE8APR" });
    expect(await sessionAccountId(await sessionRequest(env, "acct-123", "OE8APR-7"), env)).toEqual({
      accountId: "acct-123",
      callsign: "OE8APR-7",
    });
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

  it("watch.ts returns the SAME account id (as a bare string) — no divergence", async () => {
    const env = envFor({ accountId: "acct-123", base: "OE8APR" });
    expect(await watchAccountId(await sessionRequest(env, "acct-123", "OE8APR-9"), env)).toBe("acct-123");
  });

  it("returns null when signed out", async () => {
    const env = envFor({ accountId: "acct-123", base: "OE8APR" });
    const req = new Request("http://gw/api/whoami"); // no cookie
    expect(await sessionAccountId(req, env)).toBeNull();
    expect(await watchAccountId(req, env)).toBeNull();
  });
});
