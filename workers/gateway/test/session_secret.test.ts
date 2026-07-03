// SPDX-License-Identifier: AGPL-3.0-or-later
// SR-SEC-01: the session-signing key must never be a known/default value. With INGEST_SECRET at
// its committed "change-me" default (or unset), the session HMAC key is public → an attacker forges
// an `acs` cookie for any callsign, including a sysop. The gateway must mint no session on a weak
// secret, and must reject any cookie presented against one.
import { describe, it, expect } from "vitest";
import { issueSessionCookie, sessionCallsign, weakSecret } from "../src/auth.js";
import type { Env } from "../src/env.js";

const envWith = (o: Partial<Env>) => ({ ...o }) as unknown as Env;
const cookieReq = (setCookie: string) =>
  new Request("http://gw/api/whoami", { headers: { cookie: setCookie.split(";")[0]! } });

describe("SR-SEC-01 — session secret must not be the default", () => {
  it("weakSecret flags the default and empties", () => {
    expect(weakSecret(undefined)).toBe(true);
    expect(weakSecret("")).toBe(true);
    expect(weakSecret("change-me")).toBe(true);
    expect(weakSecret("a-real-strong-secret")).toBe(false);
  });

  it("refuses to mint a session when INGEST_SECRET is the default", async () => {
    await expect(issueSessionCookie("OE8APR", envWith({ INGEST_SECRET: "change-me" }))).rejects.toThrow();
  });

  it("mints and round-trips a session under a strong INGEST_SECRET", async () => {
    const env = envWith({ INGEST_SECRET: "strong-ingest-secret-xyz" });
    const setCookie = await issueSessionCookie("OE8APR", env);
    expect(await sessionCallsign(cookieReq(setCookie), env)).toBe("OE8APR");
  });

  it("a cookie minted under a strong secret is invalid against the default secret", async () => {
    const strong = envWith({ INGEST_SECRET: "strong-ingest-secret-xyz" });
    const setCookie = await issueSessionCookie("OE8APR", strong);
    // an instance that (wrongly) still runs the default must honor NO session at all
    expect(await sessionCallsign(cookieReq(setCookie), envWith({ INGEST_SECRET: "change-me" }))).toBeNull();
  });

  it("a dedicated SESSION_SECRET decouples sessions from the ingest credential", async () => {
    const a = envWith({ INGEST_SECRET: "ingest-A", SESSION_SECRET: "session-shared" });
    const b = envWith({ INGEST_SECRET: "ingest-B", SESSION_SECRET: "session-shared" });
    const setCookie = await issueSessionCookie("OE8APR", a);
    expect(await sessionCallsign(cookieReq(setCookie), b)).toBe("OE8APR"); // same SESSION_SECRET ⇒ valid
    // …but not against a different session secret
    expect(await sessionCallsign(cookieReq(setCookie), envWith({ SESSION_SECRET: "other" }))).toBeNull();
  });
});
