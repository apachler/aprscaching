// SPDX-License-Identifier: AGPL-3.0-or-later
// WebAuthn assertion verification, exercised with a real ES256 (P-256) key pair. The security-critical
// property here is the signCount replay guard: a stolen assertion (or a cloned authenticator) reuses or
// rewinds the counter, and the verifier must reject it. We also pin origin/rpId binding and that a
// tampered signature fails closed.
import { describe, it, expect } from "vitest";
import { verifyAssertion, bytesToB64url } from "../src/webauthn.js";

const enc = new TextEncoder();
const RP_ID = "aprscaching.net";
const ORIGIN = "https://aprscaching.net";
const CHALLENGE = bytesToB64url(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** CBOR-encode the COSE EC2 public key {1:2, 3:-7, -1:1, -2:x, -3:y} (webauthn.ts only decodes CBOR). */
function coseKey(x: Uint8Array, y: Uint8Array): string {
  const bstr32 = (b: Uint8Array) => concat(new Uint8Array([0x58, 0x20]), b); // major-2, 1-byte len (32)
  const map = concat(
    new Uint8Array([0xa5]), // map, 5 pairs
    new Uint8Array([0x01, 0x02]), // 1 (kty): 2 (EC2)
    new Uint8Array([0x03, 0x26]), // 3 (alg): -7 (ES256)
    new Uint8Array([0x20, 0x01]), // -1 (crv): 1 (P-256)
    concat(new Uint8Array([0x21]), bstr32(x)), // -2 (x)
    concat(new Uint8Array([0x22]), bstr32(y)), // -3 (y)
  );
  return bytesToB64url(map);
}

/** Web Crypto ECDSA emits raw r||s; verifyAssertion expects ASN.1-DER — encode it. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const trim = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0]! & 0x80) v = concat(new Uint8Array([0]), v); // keep it positive
    return v;
  };
  const r = trim(raw.slice(0, 32));
  const s = trim(raw.slice(32));
  const int = (v: Uint8Array) => concat(new Uint8Array([0x02, v.length]), v);
  const body = concat(int(r), int(s));
  return concat(new Uint8Array([0x30, body.length]), body);
}

async function authData(signCount: number): Promise<Uint8Array> {
  const rpIdHash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(RP_ID)));
  const rest = new Uint8Array(5);
  rest[0] = 0x01; // UP (user present)
  rest[1] = (signCount >>> 24) & 0xff;
  rest[2] = (signCount >>> 16) & 0xff;
  rest[3] = (signCount >>> 8) & 0xff;
  rest[4] = signCount & 0xff;
  return concat(rpIdHash, rest);
}

/** Build a valid assertion for the given counter, signed by `priv`; `origin` overridable to test binding. */
async function makeAssertion(priv: CryptoKey, coseKeyB64: string, signCount: number, origin = ORIGIN) {
  const clientDataJSON = enc.encode(JSON.stringify({ type: "webauthn.get", challenge: CHALLENGE, origin }));
  const ad = await authData(signCount);
  const clientHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataJSON));
  const rawSig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, concat(ad, clientHash)),
  );
  return {
    clientDataJSON,
    authenticatorData: ad,
    signature: rawToDer(rawSig),
    coseKey: coseKeyB64,
    challenge: CHALLENGE,
    origins: [ORIGIN],
    rpId: RP_ID,
  };
}

async function keypair() {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
  const b64u = (s: string) => {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
    const bin = atob(b64);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  };
  return { priv: kp.privateKey, cose: coseKey(b64u(jwk.x!), b64u(jwk.y!)) };
}

describe("verifyAssertion — signCount replay guard", () => {
  it("accepts a fresh assertion and returns the advanced counter", async () => {
    const { priv, cose } = await keypair();
    const r = await verifyAssertion({ ...(await makeAssertion(priv, cose, 5)), storedCounter: 0 });
    expect(r.newCounter).toBe(5);
  });

  it("rejects a REPLAYED counter (signCount == stored)", async () => {
    const { priv, cose } = await keypair();
    await expect(verifyAssertion({ ...(await makeAssertion(priv, cose, 5)), storedCounter: 5 })).rejects.toThrow(
      /signCount replay/,
    );
  });

  it("rejects a REWOUND counter (signCount < stored) — a cloned authenticator", async () => {
    const { priv, cose } = await keypair();
    await expect(verifyAssertion({ ...(await makeAssertion(priv, cose, 3)), storedCounter: 5 })).rejects.toThrow(
      /signCount replay/,
    );
  });

  it("allows signCount 0 (authenticators that don't keep a counter) even past a stored value", async () => {
    const { priv, cose } = await keypair();
    const r = await verifyAssertion({ ...(await makeAssertion(priv, cose, 0)), storedCounter: 5 });
    expect(r.newCounter).toBe(0);
  });

  it("rejects a foreign origin (phishing-origin binding)", async () => {
    const { priv, cose } = await keypair();
    const a = await makeAssertion(priv, cose, 9, "https://evil.example");
    await expect(verifyAssertion({ ...a, storedCounter: 0 })).rejects.toThrow(/origin mismatch/);
  });

  it("rejects a tampered signature (fails closed)", async () => {
    const { priv, cose } = await keypair();
    const a = await makeAssertion(priv, cose, 9);
    a.signature[a.signature.length - 1] ^= 0xff; // flip a byte of s
    await expect(verifyAssertion({ ...a, storedCounter: 0 })).rejects.toThrow();
  });
});
