// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { authorshipMessage } from "@aprsweb/shared";
import { verifyAuthorship } from "../src/keys.js";

const b64u = (buf: ArrayBuffer) => {
  let s = ""; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

describe("per-callsign authorship (F0)", () => {
  const fields = { cache: "AC-0001", instance: "oe.aprscaching.org", logger: "OE8APR", logType: "found", at: 1782000000 };

  it("verifies a device-key signature over the canonical authorship message", async () => {
    const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const pub = b64u(await crypto.subtle.exportKey("raw", kp.publicKey));
    const sig = b64u(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(authorshipMessage(fields))));

    expect(await verifyAuthorship({ ...fields, authorKey: pub, authorSig: sig })).toBe(true);
  });

  it("rejects a signature when any signed field differs", async () => {
    const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const pub = b64u(await crypto.subtle.exportKey("raw", kp.publicKey));
    const sig = b64u(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(authorshipMessage(fields))));

    expect(await verifyAuthorship({ ...fields, logType: "dnf", authorKey: pub, authorSig: sig })).toBe(false);
    expect(await verifyAuthorship({ ...fields, logger: "DL1ABC", authorKey: pub, authorSig: sig })).toBe(false);
  });
});
