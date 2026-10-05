// SPDX-License-Identifier: AGPL-3.0-or-later
// A mock database answering the session resolver's lookups for one account: its session generation and
// the base call it holds. Every other statement goes to `inner` (or answers nothing).
import type { Env } from "../src/env.js";
import { issueSessionCookie } from "../src/auth.js";

export interface SessionAccount {
  accountId: string;
  base: string;
  gen?: number;
}

type Stmt = {
  bind: (...a: unknown[]) => {
    first: () => Promise<unknown>;
    run?: () => Promise<unknown>;
    all?: () => Promise<unknown>;
  };
};

export function sessionDb(acct: SessionAccount, inner?: { prepare(sql: string): Stmt }) {
  return {
    prepare(sql: string): Stmt {
      if (sql.includes("SELECT session_gen FROM accounts WHERE account_id"))
        return {
          bind: (v: unknown) => ({
            first: async () => (v === acct.accountId ? { session_gen: acct.gen ?? 0 } : null),
          }),
        };
      if (sql.startsWith("SELECT account_id FROM account_callsigns WHERE callsign=?"))
        return {
          bind: (v: unknown) => ({ first: async () => (v === acct.base ? { account_id: acct.accountId } : null) }),
        };
      if (inner) return inner.prepare(sql);
      return {
        bind: () => ({ first: async () => null, run: async () => ({ meta: {} }), all: async () => ({ results: [] }) }),
      };
    },
    async batch() {
      return [];
    },
  };
}

/** A request carrying a session cookie for `callsign` on `accountId`. */
export async function sessionRequest(
  env: Env,
  accountId: string,
  callsign: string,
  url = "http://gw/api/whoami",
  init: RequestInit = {},
): Promise<Request> {
  const cookie = (await issueSessionCookie(new Request(url), env, accountId, callsign)).split(";")[0]!;
  return new Request(url, { ...init, headers: { ...(init.headers as Record<string, string>), cookie } });
}
