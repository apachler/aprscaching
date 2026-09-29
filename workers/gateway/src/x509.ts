// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * x509.ts — a minimal, strict X.509 certificate reader (RFC 5280) on a DER parser, plus signature checks
 * through WebCrypto. It reads exactly what callsign-certificate verification needs — the signed TBS
 * bytes, the signature and its algorithm, the issuer and subject names, the subject's attributes, the
 * validity period, the subject public key, and the basicConstraints and keyUsage extensions — and runs
 * unchanged on Workers, Node and Bun (no Node crypto, no dependency).
 *
 * DER is parsed strictly: definite lengths in their shortest form, no trailing bytes, every element
 * inside its parent. Signatures are RSASSA-PKCS1-v1_5 with SHA-1/256/384/512 (the algorithms LoTW's
 * RSA certificates use); any other algorithm fails verification.
 */
import { b64urlToBytes } from "./util/b64.js";

/** One DER element: its tag, and where its header and contents sit in the buffer. */
interface Tlv {
  tag: number;
  start: number;
  body: number;
  end: number;
}

function readTlv(buf: Uint8Array, off: number, limit: number): Tlv {
  if (off + 2 > limit) throw new Error("DER: truncated");
  const tag = buf[off]!;
  if ((tag & 0x1f) === 0x1f) throw new Error("DER: high tag numbers are not supported");
  let p = off + 1;
  let len = buf[p++]!;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error("DER: unsupported length");
    if (p + n > limit) throw new Error("DER: truncated");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p++]!;
    if (len < 0x80 || (n > 1 && buf[p - n] === 0)) throw new Error("DER: non-minimal length");
  }
  const end = p + len;
  if (end > limit) throw new Error("DER: element overruns its container");
  return { tag, start: off, body: p, end };
}

/** The elements inside a constructed element. */
function childrenOf(buf: Uint8Array, t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let p = t.body; p < t.end;) {
    const c = readTlv(buf, p, t.end);
    out.push(c);
    p = c.end;
  }
  return out;
}

function expectTag(t: Tlv | undefined, tag: number, what: string): Tlv {
  if (!t || t.tag !== tag) throw new Error(`X.509: ${what} expected`);
  return t;
}

const SEQ = 0x30;
const SET = 0x31;
const OID_TAG = 0x06;

function decodeOid(b: Uint8Array): string {
  if (b.length === 0) throw new Error("DER: empty OID");
  const parts: number[] = [];
  let v = 0;
  for (let i = 0; i < b.length; i++) {
    v = v * 128 + (b[i]! & 0x7f);
    if (!(b[i]! & 0x80)) {
      if (parts.length === 0) parts.push(v < 80 ? Math.floor(v / 40) : 2, v < 80 ? v % 40 : v - 80);
      else parts.push(v);
      v = 0;
    }
  }
  if (b[b.length - 1]! & 0x80) throw new Error("DER: truncated OID");
  return parts.join(".");
}

function decodeString(tag: number, b: Uint8Array): string | null {
  switch (tag) {
    case 0x0c: // UTF8String
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(b);
    case 0x13: // PrintableString
    case 0x16: // IA5String
    case 0x14: // TeletexString, read as Latin-1
      return String.fromCharCode(...b);
    case 0x1e: {
      // BMPString
      let s = "";
      for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i]! << 8) | b[i + 1]!);
      return s;
    }
    default:
      return null;
  }
}

function decodeTime(tag: number, b: Uint8Array): number {
  const s = String.fromCharCode(...b);
  const m =
    tag === 0x17
      ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s)
      : tag === 0x18
        ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s)
        : null;
  if (!m) throw new Error("X.509: bad validity time");
  let year = Number(m[1]);
  if (tag === 0x17) year += year >= 50 ? 1900 : 2000; // RFC 5280 §4.1.2.5.1
  return Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

export interface Certificate {
  der: Uint8Array;
  /** The signed part, verified against the issuer's key. */
  tbs: Uint8Array;
  sigAlg: string;
  signature: Uint8Array;
  serialHex: string;
  /** Issuer and subject Names as DER, compared byte for byte when building a chain. */
  issuer: Uint8Array;
  subject: Uint8Array;
  subjectAttrs: { oid: string; value: string }[];
  notBefore: number;
  notAfter: number;
  /** SubjectPublicKeyInfo as DER, and its algorithm. */
  spki: Uint8Array;
  keyAlg: string;
  /** basicConstraints cA. */
  ca: boolean;
  /** keyUsage digitalSignature; true when the certificate carries no keyUsage extension. */
  digitalSignature: boolean;
  /** keyUsage keyCertSign; true when the certificate carries no keyUsage extension. */
  keyCertSign: boolean;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Parse one DER certificate. Throws on anything malformed. */
export function parseCertificate(der: Uint8Array): Certificate {
  const root = readTlv(der, 0, der.length);
  if (root.end !== der.length) throw new Error("DER: trailing bytes");
  const [tbsT, algT, sigT] = childrenOf(der, expectTag(root, SEQ, "Certificate"));
  expectTag(tbsT, SEQ, "tbsCertificate");
  const sigAlg = decodeOid(der.subarray(...oidOf(der, expectTag(algT, SEQ, "signatureAlgorithm"))));
  const sigBits = expectTag(sigT, 0x03, "signature");
  if (der[sigBits.body] !== 0) throw new Error("X.509: signature has unused bits");
  const tbs = childrenOf(der, tbsT!);
  let i = 0;
  if (tbs[0]?.tag === 0xa0) i++; // [0] version
  const serial = expectTag(tbs[i++], 0x02, "serialNumber");
  expectTag(tbs[i++], SEQ, "signature algorithm");
  const issuer = expectTag(tbs[i++], SEQ, "issuer");
  const validity = childrenOf(der, expectTag(tbs[i++], SEQ, "validity"));
  const subject = expectTag(tbs[i++], SEQ, "subject");
  const spki = expectTag(tbs[i++], SEQ, "subjectPublicKeyInfo");
  const keyAlgSeq = expectTag(childrenOf(der, spki)[0], SEQ, "key algorithm");
  const keyAlg = decodeOid(der.subarray(...oidOf(der, keyAlgSeq)));

  const subjectAttrs: { oid: string; value: string }[] = [];
  for (const rdn of childrenOf(der, subject)) {
    for (const atv of childrenOf(der, expectTag(rdn, SET, "RelativeDistinguishedName"))) {
      const [o, v] = childrenOf(der, expectTag(atv, SEQ, "AttributeTypeAndValue"));
      const oid = decodeOid(der.subarray(expectTag(o, OID_TAG, "attribute type").body, o!.end));
      const value = v ? decodeString(v.tag, der.subarray(v.body, v.end)) : null;
      if (value !== null) subjectAttrs.push({ oid, value });
    }
  }

  let ca = false;
  let usage: number | null = null;
  const extWrap = tbs.slice(i).find((t) => t.tag === 0xa3);
  if (extWrap) {
    const exts = expectTag(childrenOf(der, extWrap)[0], SEQ, "extensions");
    for (const ext of childrenOf(der, exts)) {
      const parts = childrenOf(der, expectTag(ext, SEQ, "Extension"));
      const id = decodeOid(der.subarray(expectTag(parts[0], OID_TAG, "extnID").body, parts[0]!.end));
      const val = expectTag(parts[parts.length - 1], 0x04, "extnValue");
      const inner = readTlv(der, val.body, val.end);
      if (id === "2.5.29.19") {
        const bc = childrenOf(der, expectTag(inner, SEQ, "basicConstraints"));
        ca = bc[0]?.tag === 0x01 && der[bc[0].body] === 0xff;
      } else if (id === "2.5.29.15") {
        const bits = expectTag(inner, 0x03, "keyUsage");
        usage = bits.end - bits.body > 1 ? der[bits.body + 1]! : 0;
      }
    }
  }

  return {
    der,
    tbs: der.subarray(tbsT!.start, tbsT!.end),
    sigAlg,
    signature: der.subarray(sigBits.body + 1, sigBits.end),
    serialHex: hex(der.subarray(serial.body, serial.end)),
    issuer: der.subarray(issuer.start, issuer.end),
    subject: der.subarray(subject.start, subject.end),
    subjectAttrs,
    notBefore: decodeTime(validity[0]!.tag, der.subarray(validity[0]!.body, validity[0]!.end)),
    notAfter: decodeTime(validity[1]!.tag, der.subarray(validity[1]!.body, validity[1]!.end)),
    spki: der.subarray(spki.start, spki.end),
    keyAlg,
    ca,
    digitalSignature: usage === null || (usage & 0x80) !== 0,
    keyCertSign: usage === null || (usage & 0x04) !== 0,
  };
}

/** The [body, end) of the OID that opens an AlgorithmIdentifier. */
function oidOf(der: Uint8Array, seq: Tlv): [number, number] {
  const o = expectTag(childrenOf(der, seq)[0], OID_TAG, "algorithm OID");
  return [o.body, o.end];
}

/** The subject attribute `oid`'s value, when present once. */
export function subjectAttr(c: Certificate, oid: string): string | null {
  const vals = c.subjectAttrs.filter((a) => a.oid === oid).map((a) => a.value);
  return vals.length === 1 ? vals[0]! : null;
}

export const RSA_ENCRYPTION = "1.2.840.113549.1.1.1";
const RSA_SIG_HASH: Readonly<Record<string, string>> = {
  "1.2.840.113549.1.1.5": "SHA-1",
  "1.2.840.113549.1.1.11": "SHA-256",
  "1.2.840.113549.1.1.12": "SHA-384",
  "1.2.840.113549.1.1.13": "SHA-512",
};

// crypto.subtle's BufferSource excludes SharedArrayBuffer-backed views under newer lib typings; these
// arrays are always ArrayBuffer-backed at runtime, so the coercion is sound.
const bytes = (b: Uint8Array) => b as unknown as BufferSource;

/** Verify an RSASSA-PKCS1-v1_5 signature under a SubjectPublicKeyInfo. False on any failure. */
export async function rsaVerify(
  spki: Uint8Array,
  hash: string,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("spki", bytes(spki), { name: "RSASSA-PKCS1-v1_5", hash }, false, [
      "verify",
    ]);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, bytes(signature), bytes(data));
  } catch {
    return false;
  }
}

/** Is `cert` signed by `issuer`: names chain, and the signature verifies under the issuer's RSA key? */
export async function verifiedBy(cert: Certificate, issuer: Certificate): Promise<boolean> {
  const hash = RSA_SIG_HASH[cert.sigAlg];
  if (!hash || issuer.keyAlg !== RSA_ENCRYPTION || !sameBytes(cert.issuer, issuer.subject)) return false;
  return rsaVerify(issuer.spki, hash, cert.signature, cert.tbs);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The DER of each `CERTIFICATE` block in PEM text. A literal `\n` counts as a line break. */
export function pemBlocks(text: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  const re = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;
  for (const m of text.replace(/\\n/g, "\n").matchAll(re)) out.push(b64urlToBytes(m[1]!.replace(/\s+/g, "")));
  return out;
}

/** Standard base64 → bytes, or null when it is not base64. */
export function base64Bytes(s: unknown): Uint8Array | null {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  try {
    return b64urlToBytes(s);
  } catch {
    return null;
  }
}
