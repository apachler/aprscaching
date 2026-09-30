// SPDX-License-Identifier: AGPL-3.0-or-later
// The station page tells whether a live station is in an operator's registry and whether that registry is
// the viewer's own, so the panel offers "Add to my stations" only where adding can succeed. The owning
// account's id is never part of the answer.
import { describe, it, expect } from "vitest";
import { handleStation } from "../src/shack.js";
import type { Env } from "../src/env.js";
import { sessionDb, sessionRequest } from "./sessiondb.js";

const SESSION_SECRET = "strong-session-secret-xyz";

/** The station lookups: one station row joined to its registry owner (or none), and empty side tables. */
function stationDb(owner: string | null) {
  return {
    prepare(sql: string) {
      const none = { first: async () => null, all: async () => ({ results: [] }), run: async () => ({ meta: {} }) };
      if (sql.includes("FROM stations s LEFT JOIN account_stations a"))
        return {
          bind: () => ({
            ...none,
            first: async () => ({
              callsign: "OE8APR-12",
              lat: 47.07,
              lon: 15.42,
              symbol: "/#",
              course: null,
              speedKn: null,
              altitudeM: null,
              comment: null,
              lastSeen: 1790794800,
              roles: owner ? '["node"]' : null,
              owner,
            }),
          }),
        };
      if (sql.includes("COUNT(*)")) return { bind: () => ({ ...none, first: async () => ({ n: 3 }) }) };
      return { bind: () => none };
    },
  };
}

const envFor = (owner: string | null) =>
  ({ SESSION_SECRET, DB: sessionDb({ accountId: "acct-me", base: "OE8APR" }, stationDb(owner)) }) as unknown as Env;

async function station(env: Env, signedIn: boolean) {
  const url = "http://gw/api/stations/OE8APR-12";
  const req = signedIn ? await sessionRequest(env, "acct-me", "OE8APR", url) : new Request(url);
  const res = await handleStation(req, env, "OE8APR-12");
  return ((await res.json()) as { station: Record<string, unknown> }).station;
}

describe("station page — registry state", () => {
  it("a station in the viewer's own registry is registered and mine", async () => {
    const s = await station(envFor("acct-me"), true);
    expect(s.registered).toBe(true);
    expect(s.mine).toBe(true);
  });

  it("a station another operator registered is registered, not mine", async () => {
    const s = await station(envFor("acct-other"), true);
    expect(s.registered).toBe(true);
    expect(s.mine).toBe(false);
  });

  it("an unregistered station is neither", async () => {
    const s = await station(envFor(null), true);
    expect(s.registered).toBe(false);
    expect(s.mine).toBe(false);
  });

  it("signed out, a registered station is never mine", async () => {
    const s = await station(envFor("acct-me"), false);
    expect(s.registered).toBe(true);
    expect(s.mine).toBe(false);
  });

  it("never names the owning account", async () => {
    const s = await station(envFor("acct-other"), true);
    expect(s).not.toHaveProperty("owner");
    expect(JSON.stringify(s)).not.toContain("acct-other");
  });
});
