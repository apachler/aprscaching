// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { activeFedKeys, verifyRotationRecord, stableStringify, type FedPublicKey } from "../src/federation.js";

const b64u = (buf: ArrayBuffer) => {
  let s = ""; for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

describe("active key selection (F7/T4.1)", () => {
  const t = 1000;
  it("keeps current keys, drops revoked + out-of-window", () => {
    const keys: FedPublicKey[] = [
      { x: "current" },                          // no window → always active
      { x: "past", since: 1, until: 900 },        // window closed before t
      { x: "future", since: 2000 },               // not yet valid
      { x: "leaked", revoked: true },             // revoked
      { x: "inwindow", since: 500, until: 1500 }, // active at t
    ];
    expect(activeFedKeys(keys, t)).toEqual(["current", "inwindow"]);
  });
  it("an empty/garbage list yields no keys", () => {
    expect(activeFedKeys([], t)).toEqual([]);
    expect(activeFedKeys([{ x: "" } as FedPublicKey, null as any], t)).toEqual([]);
  });
});

describe("rotation-record continuity (F7/T4.1)", () => {
  it("verifies a new key vouched for by the previous key, rejects tampering", async () => {
    const prev = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const next = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const prevX = b64u(await crypto.subtle.exportKey("raw", prev.publicKey));
    const nextX = b64u(await crypto.subtle.exportKey("raw", next.publicKey));
    const at = 1234;
    const sig = b64u(await crypto.subtle.sign("Ed25519", prev.privateKey,
      new TextEncoder().encode(stableStringify({ key: nextX, prevKey: prevX, at }))));

    expect(await verifyRotationRecord({ key: nextX, prevKey: prevX, at, sig })).toBe(true);
    expect(await verifyRotationRecord({ key: nextX, prevKey: prevX, at: at + 1, sig })).toBe(false); // wrong ts
    expect(await verifyRotationRecord({ key: nextX, prevKey: nextX, at, sig })).toBe(false);         // wrong voucher
    expect(await verifyRotationRecord({ key: nextX, prevKey: prevX, at, sig: "AA" })).toBe(false);   // bad sig
  });
});
