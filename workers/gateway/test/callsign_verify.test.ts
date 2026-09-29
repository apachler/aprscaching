// SPDX-License-Identifier: AGPL-3.0-or-later
// Callsign control-verification: a challenge is issued only to a signed-in holder, the operator
// bootstrap needs the ingest secret, and only `VERIFY <code>` addressed to the service call is a
// verification message. The end-to-end RF flow runs against SQLite in servers/node/test.
import { describe, it, expect } from "vitest";
import { startAprsChallenge, handleOperatorVerify, parseVerifyMessage, verifyText } from "../src/callsign.js";
import type { Env } from "../src/env.js";

/** A D1 stand-in that holds nothing: these paths must refuse before they touch a row. */
function makeEnv(): Env {
  const db = {
    prepare() {
      return {
        bind() {
          return {
            async run() {
              return {};
            },
            async first() {
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
  return { DB: db, INGEST_SECRET: "trusted-secret", ADMIN_CALLSIGNS: "OE8APR" } as unknown as Env;
}

const req = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://gw" + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("callsign control-verification entry points", () => {
  it("rejects an anonymous start with 401", async () => {
    const res = await startAprsChallenge(req("/verify/aprs/start", { callsign: "OE8APR" }), makeEnv());
    expect(res.status).toBe(401);
  });

  it("does not start a challenge on the ingest secret alone", async () => {
    const res = await startAprsChallenge(
      req("/verify/aprs/start", { callsign: "OE8APR" }, { "x-ingest-secret": "trusted-secret" }),
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("the operator bootstrap needs the ingest secret", async () => {
    expect((await handleOperatorVerify(req("/verify/operator", { callsign: "OE8APR" }), makeEnv())).status).toBe(401);
    const wrong = req("/verify/operator", { callsign: "OE8APR" }, { "x-ingest-secret": "nope" });
    expect((await handleOperatorVerify(wrong, makeEnv())).status).toBe(401);
  });

  it("the operator bootstrap confirms only an ADMIN_CALLSIGNS call", async () => {
    const other = req("/verify/operator", { callsign: "DL1AAA" }, { "x-ingest-secret": "trusted-secret" });
    expect((await handleOperatorVerify(other, makeEnv())).status).toBe(403);
    const own = req("/verify/operator", { callsign: "oe8apr-9" }, { "x-ingest-secret": "trusted-secret" });
    const res = await handleOperatorVerify(own, makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verified: true, callsign: "OE8APR", method: "operator" });
  });
});

describe("parseVerifyMessage", () => {
  it.each([
    ["VERIFY 482913", "482913"],
    ["verify 482913", "482913"],
    ["  Verify   482913 ", "482913"],
    ["VERIFY", ""],
  ])("%j → %j", (text, code) => expect(parseVerifyMessage(text)).toBe(code));

  it.each(["FOUND AC-1234", "VERIFYING 1", "VERIFY 1 2", "please VERIFY 1"])("%j is not a verification", (text) =>
    expect(parseVerifyMessage(text)).toBeNull(),
  );

  it("round-trips the text the start endpoint hands out", () => {
    expect(parseVerifyMessage(verifyText("123456"))).toBe("123456");
  });
});
