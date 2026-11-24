// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * WebAuthn (passkey) verification — runtime-agnostic (Node + Bun), Web Crypto only, no deps.
 * Implements just what we need: registration (attestation "none") and authentication (assertion)
 * for ES256 (-7) and RS256 (-257) credentials, with challenge/origin/rpId checks and a signCount
 * replay guard. Attestation statements are NOT trusted/parsed (we use "none" — we only bind the
 * credential public key); that's the standard, safe choice for passwordless login.
 */
import { b64urlToBytes, bytesToB64url } from "./util/b64.js";

/** A fresh 32-byte challenge, base64url (matches what clientDataJSON.challenge encodes). */
export function randomChallenge(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return bytesToB64url(b);
}

// ---- minimal CBOR (decode only; subset used by attestationObject + COSE keys) ----
// Every length and item count is checked against the bytes left before it is acted on: the input arrives from an
// anonymous request, and a header that declares more than it carries must cost no more than its own size.
// An array or map item takes at least one byte, so a count above the bytes left is refused before the loop.
const CBOR_MAX_DEPTH = 16; // an attestationObject nests three deep (attStmt.x5c); a COSE key two
function cbor(buf: Uint8Array, off: number, depth = 0): [unknown, number] {
  if (depth > CBOR_MAX_DEPTH) throw new Error("cbor: nested too deep");
  const need = (n: number): void => {
    if (n > buf.length - off) throw new Error("cbor: truncated");
  };
  need(1);
  const b0 = buf[off++]!;
  const major = b0 >> 5;
  const info = b0 & 0x1f;
  const len = (): number => {
    if (info < 24) return info;
    if (info === 24) {
      need(1);
      return buf[off++]!;
    }
    if (info === 25) {
      need(2);
      const v = (buf[off]! << 8) | buf[off + 1]!;
      off += 2;
      return v;
    }
    if (info === 26) {
      need(4);
      const v = ((buf[off]! << 24) | (buf[off + 1]! << 16) | (buf[off + 2]! << 8) | buf[off + 3]!) >>> 0;
      off += 4;
      return v;
    }
    throw new Error("cbor: length too large");
  };
  switch (major) {
    case 0:
      return [len(), off];
    case 1: {
      const v = len();
      return [-1 - v, off];
    }
    case 2: {
      const n = len();
      need(n);
      const v = buf.slice(off, off + n);
      return [v, off + n];
    }
    case 3: {
      const n = len();
      need(n);
      const v = new TextDecoder().decode(buf.subarray(off, off + n));
      return [v, off + n];
    }
    case 4: {
      const n = len();
      need(n);
      const a: unknown[] = [];
      for (let i = 0; i < n; i++) {
        const [v, no] = cbor(buf, off, depth + 1);
        a.push(v);
        off = no;
      }
      return [a, off];
    }
    case 5: {
      const n = len();
      need(2 * n);
      const map = new Map<unknown, unknown>();
      for (let i = 0; i < n; i++) {
        const [k, n1] = cbor(buf, off, depth + 1);
        off = n1;
        const [v, n2] = cbor(buf, off, depth + 1);
        off = n2;
        map.set(k, v);
      }
      return [map, off];
    }
    default:
      throw new Error("cbor: unsupported major " + major);
  }
}
function cborFirst(buf: Uint8Array): unknown {
  return cbor(buf, 0)[0];
}

// ---- authenticatorData parsing ----
type AuthData = {
  rpIdHash: Uint8Array;
  up: boolean;
  uv: boolean;
  signCount: number;
  credId?: Uint8Array;
  coseKey?: Uint8Array;
};
function parseAuthData(d: unknown): AuthData {
  if (!(d instanceof Uint8Array) || d.length < 37) throw new Error("authenticator data truncated");
  const rpIdHash = d.slice(0, 32);
  const flags = d[32]!;
  const signCount = ((d[33]! << 24) | (d[34]! << 16) | (d[35]! << 8) | d[36]!) >>> 0;
  const out: AuthData = { rpIdHash, up: !!(flags & 0x01), uv: !!(flags & 0x04), signCount };
  if (flags & 0x40) {
    // AT — attested credential data present
    let off = 37 + 16; // skip aaguid
    if (d.length < off + 2) throw new Error("authenticator data truncated");
    const credLen = (d[off]! << 8) | d[off + 1]!;
    off += 2;
    if (credLen > d.length - off) throw new Error("authenticator data truncated");
    out.credId = d.slice(off, off + credLen);
    off += credLen;
    const end = cbor(d, off)[1]; // consume the COSE key to find its byte length
    out.coseKey = d.slice(off, end);
  }
  return out;
}

// ---- COSE key -> CryptoKey ----
async function importCose(cose: Uint8Array): Promise<{ key: CryptoKey; alg: number }> {
  const m = cborFirst(cose) as Map<number, unknown>;
  const kty = m.get(1);
  if (kty === 2) {
    // EC2 (P-256)
    const x = m.get(-2) as Uint8Array,
      y = m.get(-3) as Uint8Array;
    const raw = new Uint8Array(65);
    raw[0] = 0x04;
    raw.set(x, 1);
    raw.set(y, 33);
    return {
      key: await crypto.subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]),
      alg: -7,
    };
  }
  if (kty === 3) {
    // RSA
    const n = m.get(-1) as Uint8Array,
      e = m.get(-2) as Uint8Array;
    const jwk = { kty: "RSA", n: bytesToB64url(n), e: bytesToB64url(e), alg: "RS256", ext: true };
    return {
      key: await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
      alg: -257,
    };
  }
  throw new Error("unsupported COSE key type " + String(kty));
}

/** ASN.1-DER ECDSA-Sig-Value -> raw r||s (64 bytes) for Web Crypto ECDSA verify. */
function derToRaw(der: Uint8Array): Uint8Array {
  let off = 0;
  if (der[off++] !== 0x30) throw new Error("bad DER");
  if (der[off]! & 0x80) off += 1 + (der[off]! & 0x7f);
  else off += 1;
  const readInt = (): Uint8Array => {
    if (der[off++] !== 0x02) throw new Error("bad DER int");
    const n = der[off++]!;
    let v = der.slice(off, off + n);
    off += n;
    while (v.length > 1 && v[0] === 0) v = v.slice(1);
    if (v.length > 32) throw new Error("DER int too long");
    return v;
  };
  const r = readInt(),
    s = readInt();
  const out = new Uint8Array(64);
  out.set(r, 32 - r.length);
  out.set(s, 64 - s.length);
  return out;
}

// crypto.subtle's BufferSource excludes SharedArrayBuffer-backed views under newer lib typings;
// our arrays are always ArrayBuffer-backed at runtime, so this coercion is sound.
function bs(u: Uint8Array): BufferSource {
  return u as unknown as BufferSource;
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}
function checkClientData(clientDataJSON: Uint8Array, type: string, challenge: string, origins: string[]): void {
  const cd = JSON.parse(new TextDecoder().decode(clientDataJSON)) as {
    type: string;
    challenge: string;
    origin: string;
  };
  if (cd.type !== type) throw new Error("clientData type mismatch");
  if (cd.challenge !== challenge) throw new Error("challenge mismatch");
  if (!origins.includes(cd.origin)) throw new Error("origin mismatch: " + cd.origin);
}

/** Verify a registration (attestation "none"); returns the credential to persist. */
export async function verifyRegistration(o: {
  clientDataJSON: Uint8Array;
  attestationObject: Uint8Array;
  challenge: string;
  origins: string[];
  rpId: string;
}): Promise<{ credentialId: string; coseKey: string; signCount: number }> {
  checkClientData(o.clientDataJSON, "webauthn.create", o.challenge, o.origins);
  const att = cborFirst(o.attestationObject);
  if (!(att instanceof Map)) throw new Error("attestationObject is not a map");
  const ad = parseAuthData(att.get("authData"));
  const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(o.rpId)));
  if (!eq(ad.rpIdHash, rpHash)) throw new Error("rpId hash mismatch");
  if (!ad.up) throw new Error("user presence flag not set");
  if (!ad.credId || !ad.coseKey) throw new Error("no attested credential data");
  await importCose(ad.coseKey); // validates the key + alg is supported
  return { credentialId: bytesToB64url(ad.credId), coseKey: bytesToB64url(ad.coseKey), signCount: ad.signCount };
}

/** Verify an authentication assertion against a stored credential; returns the new signCount. */
export async function verifyAssertion(o: {
  clientDataJSON: Uint8Array;
  authenticatorData: Uint8Array;
  signature: Uint8Array;
  coseKey: string;
  challenge: string;
  origins: string[];
  rpId: string;
  storedCounter: number;
}): Promise<{ newCounter: number }> {
  checkClientData(o.clientDataJSON, "webauthn.get", o.challenge, o.origins);
  const ad = parseAuthData(o.authenticatorData);
  const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(o.rpId)));
  if (!eq(ad.rpIdHash, rpHash)) throw new Error("rpId hash mismatch");
  if (!ad.up) throw new Error("user presence flag not set");
  const { key, alg } = await importCose(b64urlToBytes(o.coseKey));
  const clientHash = new Uint8Array(await crypto.subtle.digest("SHA-256", bs(o.clientDataJSON)));
  const signed = new Uint8Array(o.authenticatorData.length + clientHash.length);
  signed.set(o.authenticatorData, 0);
  signed.set(clientHash, o.authenticatorData.length);
  const ok =
    alg === -7
      ? await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, bs(derToRaw(o.signature)), bs(signed))
      : await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, bs(o.signature), bs(signed));
  if (!ok) throw new Error("signature verification failed");
  // signCount replay guard: a non-zero authenticator must not reuse/rewind its counter.
  if (ad.signCount !== 0 && ad.signCount <= o.storedCounter) throw new Error("signCount replay");
  return { newCounter: ad.signCount };
}
