// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { activeFedKeys, verifyRotationRecord, stableStringify, type FedPublicKey, type RotationRecord } from "../src/federation.js";
import { rotationChainReaches } from "../src/federation_sync.js";

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

// SR-FED-04: the sync must only accept a peer's CHANGED key when a valid rotation chain proves
// continuity from the previously-pinned key. A hijacked domain that just swaps keys has no such proof.
describe("rotationChainReaches — SR-FED-04 key-change continuity", () => {
  async function kp() {
    const k = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    return { x: b64u(await crypto.subtle.exportKey("raw", k.publicKey)), priv: k.privateKey };
  }
  async function rot(prev: { x: string; priv: CryptoKey }, next: { x: string }, at = 1): Promise<RotationRecord> {
    const sig = b64u(await crypto.subtle.sign("Ed25519", prev.priv, new TextEncoder().encode(stableStringify({ key: next.x, prevKey: prev.x, at }))));
    return { key: next.x, prevKey: prev.x, at, sig };
  }

  it("accepts a single valid rotation A→B", async () => {
    const a = await kp(), b = await kp();
    expect(await rotationChainReaches(a.x, [b.x], [await rot(a, b)])).toBe(true);
  });

  it("accepts a multi-hop chain A→B→C", async () => {
    const a = await kp(), b = await kp(), c = await kp();
    expect(await rotationChainReaches(a.x, [c.x], [await rot(a, b), await rot(b, c)])).toBe(true);
  });

  it("rejects a key swap with NO rotation record (the hijack case)", async () => {
    const a = await kp(), evil = await kp();
    expect(await rotationChainReaches(a.x, [evil.x], [])).toBe(false);
    expect(await rotationChainReaches(a.x, [evil.x], undefined)).toBe(false);
  });

  it("rejects a chain whose record is not signed by the real predecessor", async () => {
    const a = await kp(), b = await kp(), imposter = await kp();
    // record claims prevKey=a but is signed by the imposter → verifyRotationRecord fails → no edge
    const forged: RotationRecord = { key: b.x, prevKey: a.x, at: 1,
      sig: b64u(await crypto.subtle.sign("Ed25519", imposter.priv, new TextEncoder().encode(stableStringify({ key: b.x, prevKey: a.x, at: 1 })))) };
    expect(await rotationChainReaches(a.x, [b.x], [forged])).toBe(false);
  });

  it("is trivially true when the pinned key is still among the active set", async () => {
    const a = await kp();
    expect(await rotationChainReaches(a.x, [a.x], [])).toBe(true);
  });
});
