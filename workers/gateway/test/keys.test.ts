// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { authorshipMessage } from "@aprscaching/shared";
import { verifyAuthorship, handleRegisterKey } from "../src/keys.js";
import type { Env } from "../src/env.js";

const b64u = (buf: ArrayBuffer) => {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

// Registering a device key binds it to a callsign, and destructive account actions
// (delete / bundle / move) authorise against "any registered key" — so anonymous registration is
// an account-takeover primitive. Anonymous ⇒ 401; a session may only bind its own base call.
describe("handleRegisterKey — registration is authenticated", () => {
  const dbNever = {
    prepare: () => {
      throw new Error("DB must not be touched before auth");
    },
  };
  const env = { INGEST_SECRET: "s3cret-for-tests", DB: dbNever } as unknown as Env;
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("http://gw/keys/register", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...headers },
    });

  it("rejects an anonymous request with a body callsign (401, no DB write)", async () => {
    const res = await handleRegisterKey(
      post({ callsign: "OE8APR", publicKey: "QUJDREVGR0hJSktMTU5PUEFCQ0RFRkdISUpLTE1OT1A" }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("accepts the trusted ingest daemon (shared secret) for a heard callsign", async () => {
    const rows: unknown[][] = [];
    const db = {
      prepare: (_sql: string) => ({
        bind: (...args: unknown[]) => ({
          run: async () => {
            rows.push(args);
            return {};
          },
          first: async () => null, // isCallsignVerified → not verified
          all: async () => ({ results: [] }),
        }),
      }),
    };
    const res = await handleRegisterKey(
      post(
        { callsign: "DL1ABC", publicKey: "QUJDREVGR0hJSktMTU5PUEFCQ0RFRkdISUpLTE1OT1A" },
        { "x-ingest-secret": "s3cret-for-tests" },
      ),
      { INGEST_SECRET: "s3cret-for-tests", DB: db } as unknown as Env,
    );
    expect(res.status).toBe(200);
    expect(rows.length).toBeGreaterThan(0); // the key row was written
  });
});

describe("per-callsign authorship", () => {
  const fields = {
    cache: "AC-0001",
    instance: "oe.aprscaching.org",
    logger: "OE8APR",
    logType: "found",
    at: 1782000000,
  };

  it("verifies a device-key signature over the canonical authorship message", async () => {
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pub = b64u(await crypto.subtle.exportKey("raw", kp.publicKey));
    const sig = b64u(
      await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(authorshipMessage(fields))),
    );

    expect(await verifyAuthorship({ ...fields, authorKey: pub, authorSig: sig })).toBe(true);
  });

  it("rejects a signature when any signed field differs", async () => {
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pub = b64u(await crypto.subtle.exportKey("raw", kp.publicKey));
    const sig = b64u(
      await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(authorshipMessage(fields))),
    );

    expect(await verifyAuthorship({ ...fields, logType: "dnf", authorKey: pub, authorSig: sig })).toBe(false);
    expect(await verifyAuthorship({ ...fields, logger: "DL1ABC", authorKey: pub, authorSig: sig })).toBe(false);
  });
});
