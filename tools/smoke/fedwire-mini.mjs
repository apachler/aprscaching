// SPDX-License-Identifier: AGPL-3.0-or-later
// An INDEPENDENT minimal implementation of the fedwire encoding for the conformance suite: enough
// deterministic CBOR (RFC 8949 §4.2 core subset) to build and read signed frames and sync pages
// without importing the production codec — a deliberate cross-implementation check. A byte of
// divergence from the canonical form makes the gateway reject the frame, failing the smoke loudly.

const te = new TextEncoder();
const td = new TextDecoder();

function head(major, arg) {
  if (arg < 24) return [(major << 5) | arg];
  if (arg < 0x100) return [(major << 5) | 24, arg];
  if (arg < 0x10000) return [(major << 5) | 25, arg >> 8, arg & 0xff];
  if (arg < 0x100000000)
    return [(major << 5) | 26, (arg >>> 24) & 0xff, (arg >>> 16) & 0xff, (arg >>> 8) & 0xff, arg & 0xff];
  throw new Error("mini-cbor: arg too large");
}

export function cborEncode(v) {
  const out = [];
  encodeInto(out, v);
  return Uint8Array.from(out);
}
function encodeInto(out, v) {
  if (v === null) return void out.push(0xf6);
  if (v === true) return void out.push(0xf5);
  if (v === false) return void out.push(0xf4);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error("mini-cbor: integers only");
    if (v >= 0) return void out.push(...head(0, v));
    return void out.push(...head(1, -1 - v));
  }
  if (typeof v === "string") {
    const b = te.encode(v);
    out.push(...head(3, b.length), ...b);
    return;
  }
  if (v instanceof Uint8Array) return void out.push(...head(2, v.length), ...v);
  if (Array.isArray(v)) {
    out.push(...head(4, v.length));
    for (const x of v) encodeInto(out, x);
    return;
  }
  if (v instanceof Map) {
    const entries = [...v.entries()].map(([k, val]) => ({ kb: cborEncode(k), val }));
    entries.sort((a, b) => cmpBytes(a.kb, b.kb)); // canonical: keys sorted by their encoded bytes
    out.push(...head(5, entries.length));
    for (const e of entries) {
      out.push(...e.kb);
      encodeInto(out, e.val);
    }
    return;
  }
  throw new Error("mini-cbor: unsupported value");
}
function cmpBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
export function objToMap(obj) {
  const m = new Map();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) m.set(k, v);
  return m;
}

export function cborDecode(bytes) {
  const r = { buf: bytes, off: 0 };
  const v = item(r);
  if (r.off !== bytes.length) throw new Error("mini-cbor: trailing bytes");
  return v;
}
function item(r) {
  const b0 = r.buf[r.off++];
  const major = b0 >> 5;
  const info = b0 & 0x1f;
  let arg = info;
  if (info === 24) arg = r.buf[r.off++];
  else if (info === 25) {
    arg = (r.buf[r.off] << 8) | r.buf[r.off + 1];
    r.off += 2;
  } else if (info === 26) {
    arg = r.buf[r.off] * 0x1000000 + ((r.buf[r.off + 1] << 16) | (r.buf[r.off + 2] << 8) | r.buf[r.off + 3]);
    r.off += 4;
  } else if (info >= 27) {
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
    }
    throw new Error("mini-cbor: unsupported head");
  }
  switch (major) {
    case 0:
      return arg;
    case 1:
      return -1 - arg;
    case 2: {
      const out = r.buf.slice(r.off, r.off + arg);
      r.off += arg;
      return out;
    }
    case 3: {
      const s = td.decode(r.buf.subarray(r.off, r.off + arg));
      r.off += arg;
      return s;
    }
    case 4: {
      const a = [];
      for (let i = 0; i < arg; i++) a.push(item(r));
      return a;
    }
    case 5: {
      const m = new Map();
      for (let i = 0; i < arg; i++) {
        const k = item(r);
        m.set(k, item(r));
      }
      return m;
    }
    case 7:
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      throw new Error("mini-cbor: unsupported simple");
    default:
      throw new Error("mini-cbor: unsupported major " + major);
  }
}

const DOMAIN = te.encode("acs-fed/1\n");

/** Build a signed fedwire frame for a record; `kindNum` per FED_RECORD_TYPE (cache=1, tombstone=5). */
export async function buildFrame(rec, privateKey, signerKeyB64u) {
  const payload = cborEncode(
    new Map([
      [1, rec.kind],
      [2, rec.gid],
      [3, rec.origin],
      [4, rec.v],
      [5, rec.at],
      [6, rec.signer],
      [7, objToMap(rec.body)],
    ]),
  );
  const msg = new Uint8Array(DOMAIN.length + payload.length);
  msg.set(DOMAIN, 0);
  msg.set(payload, DOMAIN.length);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, msg));
  return frameFromParts(payload, signerKeyB64u, sig);
}
export function frameFromParts(payload, signerKeyB64u, sig) {
  return cborEncode(
    new Map([
      [1, payload],
      [2, signerKeyB64u],
      [3, sig],
    ]),
  );
}
/** Split a frame into its envelope parts; the payload decodes with cborDecode when needed. */
export function frameParts(frameBytes) {
  const m = cborDecode(frameBytes);
  return { payload: m.get(1), signerKey: m.get(2), sig: m.get(3) };
}
export const signingBytes = (payload) => {
  const msg = new Uint8Array(DOMAIN.length + payload.length);
  msg.set(DOMAIN, 0);
  msg.set(payload, DOMAIN.length);
  return msg;
};

export function encodePage(instance, nextCursor, complete, frames) {
  return cborEncode(
    new Map([
      [1, instance],
      [2, nextCursor],
      [3, complete],
      [4, frames],
    ]),
  );
}
export function decodePage(bytes) {
  const m = cborDecode(bytes);
  return { instance: m.get(1), nextCursor: m.get(2), complete: m.get(3), frames: m.get(4) ?? [] };
}
