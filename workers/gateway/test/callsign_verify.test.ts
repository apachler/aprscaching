// SPDX-License-Identifier: AGPL-3.0-or-later
// The APRS control-verification confirm requires a session or the trusted ingest secret, locks after
// a few wrong guesses, and expires — without those, an unauthenticated, unthrottled endpoint matching
// a Math.random 6-digit code lets ~10^6 guesses verify any callsign.
import { describe, it, expect } from "vitest";
import { startAprsChallenge, confirmAprsChallenge } from "../src/callsign.js";
import type { Env } from "../src/env.js";

/** Tiny in-memory stand-in for the D1 surface these handlers touch. */
function makeEnv(): Env {
  const rows = new Map<string, Record<string, unknown>>();
  const db = {
    prepare(sql: string) {
      return {
        bind(...a: unknown[]) {
          return {
            async run() {
              if (/INSERT INTO callsign_verifications/.test(sql)) {
                rows.set(String(a[0]), {
                  callsign: a[0],
                  challenge: a[1],
                  account_id: a[2],
                  attempts: 0,
                  created_at: a[3],
                  status: "pending",
                });
              } else if (/UPDATE callsign_verifications SET attempts/.test(sql)) {
                // a = [MAX, cs]
                const r = rows.get(String(a[1]));
                if (r) {
                  r.attempts = (r.attempts as number) + 1;
                  if ((r.attempts as number) >= (a[0] as number)) r.status = "failed";
                }
              } else if (/INSERT INTO aprs_outbox/.test(sql)) {
                /* ignore */
              }
              return {};
            },
            async first() {
              if (/FROM callsign_verifications/.test(sql)) return rows.get(String(a[0])) ?? null;
              if (/FROM accounts WHERE callsign/.test(sql)) return { account_id: "acct-1" }; // session → account
              return null;
            },
            async all() {
              return { results: [] };
            },
          };
        },
      };
    },
    async batch() {
      return [];
    },
  };
  return { DB: db, INGEST_SECRET: "trusted-secret" } as unknown as Env;
}

const ingestReq = (body: unknown) =>
  new Request("http://gw/verify/aprs/confirm", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ingest-secret": "trusted-secret" },
    body: JSON.stringify(body),
  });
const anonReq = (path: string, body: unknown) =>
  new Request("http://gw/verify/aprs/" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function readCode(env: Env): Promise<string> {
  // pull the code the handler stored (the smoke reads it off the outbox; here off our map)
  const r = await env.DB.prepare(
    "SELECT challenge, account_id, attempts, created_at, status FROM callsign_verifications WHERE callsign = ?",
  )
    .bind("OE8APR")
    .first<{ challenge: string }>();
  return r!.challenge;
}

describe("APRS verification is authenticated + throttled", () => {
  it("rejects an anonymous start (no session, no ingest secret) with 401", async () => {
    const res = await startAprsChallenge(anonReq("start", { callsign: "OE8APR" }), makeEnv());
    expect(res.status).toBe(401);
  });

  it("rejects an anonymous confirm with 401", async () => {
    const res = await confirmAprsChallenge(anonReq("confirm", { callsign: "OE8APR", code: "123456" }), makeEnv());
    expect(res.status).toBe(401);
  });

  it("verifies with the correct code over the trusted path", async () => {
    const env = makeEnv();
    await startAprsChallenge(ingestReq({ callsign: "OE8APR" }), env);
    const code = await readCode(env);
    const res = await confirmAprsChallenge(ingestReq({ callsign: "OE8APR", code }), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { verified: boolean }).verified).toBe(true);
  });

  it("locks the challenge after 5 wrong guesses (429), defeating brute force", async () => {
    const env = makeEnv();
    await startAprsChallenge(ingestReq({ callsign: "OE8APR" }), env);
    const realCode = await readCode(env);
    const wrong = realCode === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      const r = await confirmAprsChallenge(ingestReq({ callsign: "OE8APR", code: wrong }), env);
      expect(r.status).toBe(400); // wrong code
    }
    // 6th attempt: locked, and even the CORRECT code no longer works
    const locked = await confirmAprsChallenge(ingestReq({ callsign: "OE8APR", code: realCode }), env);
    expect([400, 429]).toContain(locked.status);
    expect(((await locked.json()) as { verified: boolean }).verified).toBe(false);
  });
});
