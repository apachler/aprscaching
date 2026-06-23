import { describe, it, expect } from "vitest";
import { stableStringify } from "../src/federation.js";

describe("stableStringify — canonical JSON", () => {
  it("is key-order independent", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(stableStringify({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });
  it("handles nesting, arrays, null", () => {
    const s = stableStringify({ z: [3, { y: 1, x: 2 }], a: null });
    expect(s).toBe('{"a":null,"z":[3,{"x":2,"y":1}]}');
  });
});

describe("Ed25519 record signing (WebCrypto)", () => {
  it("signs a canonical record and verifies with the public key", async () => {
    const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const id = "oe.aprscaching.org:cache:1";
    const data = { code: "AC-0001", title: "Schlossberg", lat: 47.07, lon: 15.42 };
    const msg = new TextEncoder().encode(stableStringify({ type: "cache", id, data }));

    const sig = await crypto.subtle.sign("Ed25519", kp.privateKey, msg);
    const good = await crypto.subtle.verify("Ed25519", kp.publicKey, sig, msg);
    expect(good).toBe(true);

    // a tampered payload must NOT verify
    const tampered = new TextEncoder().encode(
      stableStringify({ type: "cache", id, data: { ...data, lat: 0 } }),
    );
    const bad = await crypto.subtle.verify("Ed25519", kp.publicKey, sig, tampered);
    expect(bad).toBe(false);
  });

  it("a public JWK round-trips for verification (how a mirror checks a feed)", async () => {
    const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const pubJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
    const imported = await crypto.subtle.importKey("jwk", pubJwk, { name: "Ed25519" }, false, ["verify"]);
    const msg = new TextEncoder().encode("hello");
    const sig = await crypto.subtle.sign("Ed25519", kp.privateKey, msg);
    expect(await crypto.subtle.verify("Ed25519", imported, sig, msg)).toBe(true);
  });
});
