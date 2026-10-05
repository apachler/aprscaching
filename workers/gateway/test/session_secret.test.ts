// SPDX-License-Identifier: AGPL-3.0-or-later
// The session-signing key is SESSION_SECRET and nothing else. A known/default value, an unset one, or
// one shared with a machine credential (INGEST_SECRET, OPERATOR_SECRET) would let the holder of that
// value forge an `acs` cookie for any account, including a sysop — so the gateway mints no session and
// honours no cookie in any of those states.
import { describe, it, expect } from "vitest";
import { issueSessionCookie, sessionIdentity, weakSecret, sessionsEnabled } from "../src/auth.js";
import type { Env } from "../src/env.js";
import { sessionDb, sessionRequest } from "./sessiondb.js";

const ACCT = { accountId: "acct-1", base: "OE8APR" };
const envWith = (o: Partial<Env>) => ({ DB: sessionDb(ACCT), ...o }) as unknown as Env;
const sessionCallsign = async (req: Request, env: Env) => (await sessionIdentity(req, env))?.callsign ?? null;
const reqWith = (setCookie: string) =>
  new Request("http://gw/api/whoami", { headers: { cookie: setCookie.split(";")[0]! } });

describe("session secret", () => {
  it("weakSecret flags the default and empties", () => {
    expect(weakSecret(undefined)).toBe(true);
    expect(weakSecret("")).toBe(true);
    expect(weakSecret("change-me")).toBe(true);
    expect(weakSecret("a-real-strong-secret")).toBe(false);
  });

  it("refuses to mint without SESSION_SECRET, however strong INGEST_SECRET is", async () => {
    const env = envWith({ INGEST_SECRET: "strong-ingest-secret-xyz" });
    expect(sessionsEnabled(env)).toBe(false);
    await expect(issueSessionCookie(new Request("http://gw/"), env, "acct-1", "OE8APR")).rejects.toThrow(
      /SESSION_SECRET/,
    );
  });

  it("refuses a default SESSION_SECRET, or one equal to a machine secret", async () => {
    for (const o of [
      { SESSION_SECRET: "change-me" },
      { SESSION_SECRET: "shared-value-123", INGEST_SECRET: "shared-value-123" },
      { SESSION_SECRET: "shared-value-123", OPERATOR_SECRET: "shared-value-123" },
    ])
      await expect(issueSessionCookie(new Request("http://gw/"), envWith(o), "acct-1", "OE8APR")).rejects.toThrow();
  });

  it("mints and round-trips a session under a dedicated SESSION_SECRET", async () => {
    const env = envWith({ INGEST_SECRET: "ingest-A", SESSION_SECRET: "session-strong-1" });
    expect(await sessionCallsign(await sessionRequest(env, "acct-1", "OE8APR"), env)).toBe("OE8APR");
  });

  it("the ingest secret does not change session validity; the session secret does", async () => {
    const a = envWith({ INGEST_SECRET: "ingest-A", SESSION_SECRET: "session-shared" });
    const b = envWith({ INGEST_SECRET: "ingest-B", SESSION_SECRET: "session-shared" });
    const setCookie = await issueSessionCookie(new Request("http://gw/"), a, "acct-1", "OE8APR");
    expect(await sessionCallsign(reqWith(setCookie), b)).toBe("OE8APR");
    expect(await sessionCallsign(reqWith(setCookie), envWith({ SESSION_SECRET: "other-session" }))).toBeNull();
    // an instance that loses its session secret honours no cookie at all
    expect(await sessionCallsign(reqWith(setCookie), envWith({ INGEST_SECRET: "ingest-A" }))).toBeNull();
  });
});
