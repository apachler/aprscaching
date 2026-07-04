// SPDX-License-Identifier: AGPL-3.0-or-later
// One canonical account resolver. A person holds one or more BASE calls in account_callsigns (the
// durable multi-call model), so the active SSID must map to the same account no matter which call
// the session is bound to. auth.ts owns the logic; watch.ts re-exports a bare-string wrapper. This
// pins both to the same answer: account_callsigns (by base call) first, accounts as the fallback.
import { describe, it, expect } from "vitest";
import { issueSessionCookie, sessionAccountId } from "../src/auth.js";
import { sessionAccountId as watchAccountId } from "../src/watch.js";
import type { Env } from "../src/env.js";

const SECRET = "strong-ingest-secret-xyz";

/** Mock DB answering the two account lookups; records which tables were queried and with what bind. */
function accountDb(opts: { byBase?: string; byExact?: string }) {
  const seen: { table: string; bind: string }[] = [];
  return {
    seen,
    db: {
      prepare(sql: string) {
        const table = sql.includes("account_callsigns") ? "account_callsigns" : "accounts";
        return {
          bind(v: string) {
            seen.push({ table, bind: v });
            return {
              async first() {
                const id = table === "account_callsigns" ? opts.byBase : opts.byExact;
                return id ? { account_id: id } : null;
              },
            };
          },
        };
      },
    },
  };
}

async function cookieReq(callsign: string, env: Env) {
  const setCookie = await issueSessionCookie(callsign, env);
  return new Request("http://gw/api/whoami", { headers: { cookie: setCookie.split(";")[0]! } });
}

describe("sessionAccountId — one canonical resolver", () => {
  it("resolves via account_callsigns by BASE call (an SSID maps to the same account)", async () => {
    const { db, seen } = accountDb({ byBase: "acct-123" });
    const env = { INGEST_SECRET: SECRET, DB: db } as unknown as Env;
    const me = await sessionAccountId(await cookieReq("OE8APR-7", env), env);
    expect(me).toEqual({ accountId: "acct-123", callsign: "OE8APR-7" });
    // the account_callsigns lookup is keyed by the BASE call, not the SSID
    expect(seen[0]).toEqual({ table: "account_callsigns", bind: "OE8APR" });
  });

  it("falls back to accounts (active-call anchor) when no account_callsigns row exists", async () => {
    const { db, seen } = accountDb({ byExact: "acct-legacy" });
    const env = { INGEST_SECRET: SECRET, DB: db } as unknown as Env;
    const me = await sessionAccountId(await cookieReq("OE8APR", env), env);
    expect(me?.accountId).toBe("acct-legacy");
    expect(seen.map((s) => s.table)).toEqual(["account_callsigns", "accounts"]);
  });

  it("watch.ts returns the SAME account id (as a bare string) — no divergence", async () => {
    const { db } = accountDb({ byBase: "acct-123" });
    const env = { INGEST_SECRET: SECRET, DB: db } as unknown as Env;
    expect(await watchAccountId(await cookieReq("OE8APR-9", env), env)).toBe("acct-123");
  });

  it("returns null when signed out", async () => {
    const { db } = accountDb({ byBase: "acct-123" });
    const env = { INGEST_SECRET: SECRET, DB: db } as unknown as Env;
    const req = new Request("http://gw/api/whoami"); // no cookie
    expect(await sessionAccountId(req, env)).toBeNull();
    expect(await watchAccountId(req, env)).toBeNull();
  });
});
