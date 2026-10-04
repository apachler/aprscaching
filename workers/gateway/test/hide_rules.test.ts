// SPDX-License-Identifier: AGPL-3.0-or-later
// Hiding a cache takes a control-verified call, and one account hides at most HIDE_DAILY_LIMIT new caches a day.
import { describe, it, expect } from "vitest";
import { handleCreateCache } from "../src/caches.js";
import { sessionDb, sessionRequest } from "./sessiondb.js";
import type { Env } from "../src/env.js";

const SESSION_SECRET = "strong-session-secret-xyz";
const BODY = { title: "Schlossberg", type: "traditional", lat: 47.07, lon: 15.44, difficulty: 1, terrain: 1 };

function db(verified: boolean, hiddenToday: number, sink: { inserts: number; countBinds: unknown[][] }) {
  return sessionDb(
    { accountId: "acct-1", base: "OE8APR" },
    {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first() {
                if (sql.includes("COUNT(*) AS n FROM caches c")) {
                  sink.countBinds.push(args);
                  return { n: hiddenToday };
                }
                if (sql.startsWith("SELECT * FROM caches")) return { id: 1, code: "AC-0001", ...BODY };
                return null;
              },
              async all() {
                if (!sql.includes("callsign_verifications") || !verified) return { results: [] };
                return { results: args.map((c) => ({ callsign: c, method: "operator" })) };
              },
              async run() {
                if (sql.includes("INSERT INTO caches")) sink.inserts++;
                return { meta: { last_row_id: 1, changes: 1 } };
              },
            };
          },
        };
      },
    },
  );
}

async function hide(env: Env): Promise<Response> {
  const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(BODY) };
  return handleCreateCache(await sessionRequest(env, "acct-1", "OE8APR", "http://gw/api/caches", init), env);
}

describe("hide rules", () => {
  it("refuses a member whose call is not control-verified", async () => {
    const sink = { inserts: 0, countBinds: [] as unknown[][] };
    const env = { SESSION_SECRET, DB: db(false, 0, sink) } as unknown as Env;
    const res = await hide(env);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/verify OE8APR to hide a cache/);
    expect(sink.inserts).toBe(0);
  });

  it("lets a verified member hide under the daily limit", async () => {
    const sink = { inserts: 0, countBinds: [] as unknown[][] };
    const env = { SESSION_SECRET, DB: db(true, 4, sink) } as unknown as Env;
    expect((await hide(env)).status).toBe(201);
    expect(sink.inserts).toBe(1);
    expect(sink.countBinds[0]![1]).toBe("acct-1"); // counted per account, every call it holds
  });

  it("refuses the hide past the daily limit with 429", async () => {
    const sink = { inserts: 0, countBinds: [] as unknown[][] };
    const env = { SESSION_SECRET, DB: db(true, 5, sink) } as unknown as Env;
    const res = await hide(env);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ limit: 5, error: expect.stringMatching(/try again tomorrow/) });
    expect(sink.inserts).toBe(0);
  });

  it("HIDE_DAILY_LIMIT sets the limit, 0 lifts it, junk keeps the default", async () => {
    const statusWith = async (limit: string, hidden: number) =>
      (
        await hide({
          SESSION_SECRET,
          HIDE_DAILY_LIMIT: limit,
          DB: db(true, hidden, { inserts: 0, countBinds: [] }),
        } as unknown as Env)
      ).status;
    expect(await statusWith("2", 1)).toBe(201);
    expect(await statusWith("2", 2)).toBe(429);
    expect(await statusWith("x", 4)).toBe(201);
    expect(await statusWith("x", 5)).toBe(429);
    const sink = { inserts: 0, countBinds: [] as unknown[][] };
    const env = { SESSION_SECRET, HIDE_DAILY_LIMIT: "0", DB: db(true, 99, sink) } as unknown as Env;
    expect((await hide(env)).status).toBe(201);
    expect(sink.countBinds).toHaveLength(0);
  });
});
