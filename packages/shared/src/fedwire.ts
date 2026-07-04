// SPDX-License-Identifier: MIT
/**
 * fedwire.ts — the federation wire format. A federation record is deterministic CBOR (cbor.ts)
 * signed under a domain-separated Ed25519 signature; the same signed bytes travel verbatim over
 * every transport binding (HTTP/44net sync, AX.25/NET-ROM circuits, BBS store-and-forward), so a
 * record's authenticity lives in its bytes, never in the path it took.
 *
 * Layout (all integer-keyed for compactness; bodies are text-keyed and self-describing):
 *
 *   payload  = canonical CBOR of {1 type, 2 gid, 3 origin, 4 v, 5 at, 6 signer, 7 body}
 *   signed   = utf8(FED_DOMAIN) || payload           — domain separation: no cross-protocol replay
 *   frame    = canonical CBOR of {1 payload(bytes), 2 signerKey(text, b64url raw Ed25519), 3 sig(bytes)}
 *
 * `gid` ("origin:kind:localid") is the content address: apply is idempotent by (type, gid) with `v`
 * as the per-gid monotonic version, so duplicated / re-ordered / multi-path delivery converges.
 * Coordinates travel as integers in 1e-7-degree units — floats are excluded from the signed form
 * because their encoding is not byte-deterministic across encoders.
 */
import { z } from "zod";
import { cborEncode, cborDecode, toCborValue, fromCborValue, type CborMap, type CborValue } from "./cbor.js";

/** Domain-separation prefix over the signed payload (the /1 is the wire era). */
export const FED_DOMAIN = "acs-fed/1\n";

/** Record types (the envelope's integer `type`). */
export const FED_RECORD_TYPE = {
  cache: 1,
  find: 2,
  key: 3,
  bulletin: 4,
  tombstone: 5,
  accountMove: 6,
  peer: 7,
} as const;
export type FedRecordKind = keyof typeof FED_RECORD_TYPE;

const KIND_BY_TYPE = new Map<number, FedRecordKind>(
  (Object.keys(FED_RECORD_TYPE) as FedRecordKind[]).map((k) => [FED_RECORD_TYPE[k], k]),
);

export interface FedRecord {
  kind: FedRecordKind;
  gid: string; // content address: "origin:kind:localid"
  origin: string; // originating instance id
  v: number; // per-gid monotonic version — drives idempotent apply
  at: number; // signed_at, unix seconds
  signer: string; // callsign or instance id
  body: Record<string, unknown>; // type-specific fields (text-keyed, integers only for numbers)
}

// envelope keys
const K_TYPE = 1,
  K_GID = 2,
  K_ORIGIN = 3,
  K_V = 4,
  K_AT = 5,
  K_SIGNER = 6,
  K_BODY = 7;
// frame keys
const F_PAYLOAD = 1,
  F_KEY = 2,
  F_SIG = 3;

/** Encode a record's payload (the bytes the signature covers, minus the domain prefix). */
export function encodeFedPayload(r: FedRecord): Uint8Array {
  const type = FED_RECORD_TYPE[r.kind];
  if (!type) throw new Error(`fedwire: unknown record kind ${r.kind}`);
  const m: CborMap = new Map<number, CborValue>([
    [K_TYPE, type],
    [K_GID, r.gid],
    [K_ORIGIN, r.origin],
    [K_V, r.v],
    [K_AT, r.at],
    [K_SIGNER, r.signer],
    [K_BODY, toCborValue(r.body)],
  ]);
  return cborEncode(m);
}

function req<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`fedwire: payload missing ${what}`);
  return v;
}

/** Decode + validate a payload back into a typed record. Throws on any malformed field. */
export function decodeFedPayload(bytes: Uint8Array): FedRecord {
  const m = cborDecode(bytes);
  if (!(m instanceof Map)) throw new Error("fedwire: payload is not a map");
  const type = req(m.get(K_TYPE), "type");
  if (typeof type !== "number") throw new Error("fedwire: record type must be an integer");
  const kind = KIND_BY_TYPE.get(type);
  if (!kind) throw new Error(`fedwire: unknown record type ${type}`);
  const gid = req(m.get(K_GID), "gid");
  const origin = req(m.get(K_ORIGIN), "origin");
  const v = req(m.get(K_V), "v");
  const at = req(m.get(K_AT), "at");
  const signer = req(m.get(K_SIGNER), "signer");
  const body = req(m.get(K_BODY), "body");
  if (typeof gid !== "string" || typeof origin !== "string" || typeof signer !== "string")
    throw new Error("fedwire: gid/origin/signer must be text");
  if (typeof v !== "number" || typeof at !== "number") throw new Error("fedwire: v/at must be integers");
  if (!(body instanceof Map)) throw new Error("fedwire: body must be a map");
  return { kind, gid, origin, v, at, signer, body: fromCborValue(body) as Record<string, unknown> };
}

const domainBytes = new TextEncoder().encode(FED_DOMAIN);

/** The exact bytes an Ed25519 signature covers: the domain prefix + the canonical payload. */
export function fedSigningBytes(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(domainBytes.length + payload.length);
  out.set(domainBytes, 0);
  out.set(payload, domainBytes.length);
  return out;
}

/** Assemble the wire frame around a signed payload. */
export function encodeFedFrame(payload: Uint8Array, signerKey: string, sig: Uint8Array): Uint8Array {
  const m: CborMap = new Map<number, CborValue>([
    [F_PAYLOAD, payload],
    [F_KEY, signerKey],
    [F_SIG, sig],
  ]);
  return cborEncode(m);
}

export interface FedFrame {
  payload: Uint8Array; // verbatim signed payload bytes — verify against these, never a re-encode
  signerKey: string; // raw Ed25519 public key, base64url
  sig: Uint8Array;
  record: FedRecord; // the decoded payload, for convenience
}

/** Parse a wire frame. Signature verification is the caller's job (crypto stays runtime-owned). */
export function decodeFedFrame(bytes: Uint8Array): FedFrame {
  const m = cborDecode(bytes);
  if (!(m instanceof Map)) throw new Error("fedwire: frame is not a map");
  const payload = m.get(F_PAYLOAD);
  const signerKey = m.get(F_KEY);
  const sig = m.get(F_SIG);
  if (!(payload instanceof Uint8Array) || !(sig instanceof Uint8Array) || typeof signerKey !== "string")
    throw new Error("fedwire: malformed frame");
  return { payload, signerKey, sig, record: decodeFedPayload(payload) };
}

// ---- coordinates: 1e-7-degree integers (~1 cm), byte-deterministic across every encoder ----

export function toE7(deg: number): number {
  if (!Number.isFinite(deg) || Math.abs(deg) > 180) throw new Error("fedwire: coordinate out of range");
  return Math.round(deg * 1e7);
}
export function fromE7(e7: number): number {
  return e7 / 1e7;
}

// ---- typed peer endpoints: identity is the instance id + key; addresses are signed data ----

export const FedTransportKind = z.enum(["https", "44net", "ax25", "netrom", "bbs"]);
export type FedTransportKind = z.infer<typeof FedTransportKind>;

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/i;
const CALLSIGN_SSID_RE = /^[A-Z0-9]{3,9}(-(?:[0-9]|1[0-5]))?$/;
const NETROM_ALIAS_RE = /^[A-Z0-9#]{1,6}$/;
const BBS_HIER_RE = /^[A-Z0-9-]{3,9}@[A-Z0-9][A-Z0-9.#-]{1,60}$/i;

/** Per-kind address validation — an endpoint with a malformed address never enters a peer record. */
export function validEndpointAddress(transport: FedTransportKind, address: string): boolean {
  switch (transport) {
    case "https":
      try {
        const u = new URL(address);
        return u.protocol === "https:" || u.protocol === "http:"; // plain http exists inside HAMNET/44net space
      } catch {
        return false;
      }
    case "44net":
      // a NAME (survives renumbering + IPv6), never a raw 44.x address — reject IPv4-literal shapes
      return HOSTNAME_RE.test(address) && !/^\d+(\.\d+)+$/.test(address);
    case "ax25":
      return CALLSIGN_SSID_RE.test(address.toUpperCase());
    case "netrom":
      return NETROM_ALIAS_RE.test(address.toUpperCase());
    case "bbs":
      return BBS_HIER_RE.test(address); // CALL@BBS hierarchical address, e.g. OE8APR@OE8XBB.#KTN.AUT.EU
  }
}

export const FedEndpoint = z
  .object({
    transport: FedTransportKind,
    address: z.string().min(1).max(200),
    priority: z.number().int().min(0).max(100).default(50), // lower tries first
    verifiedVia: z.string().max(40).optional(), // identity attestation, e.g. "ardc-lot" (44net LoT review)
  })
  .refine((e) => validEndpointAddress(e.transport, e.address), { message: "address is invalid for its transport" });
export type FedEndpoint = z.infer<typeof FedEndpoint>;

/** Parse a stored/received endpoint list, dropping anything malformed rather than failing the peer. */
export function parseEndpoints(raw: unknown): FedEndpoint[] {
  if (!Array.isArray(raw)) return [];
  const out: FedEndpoint[] = [];
  for (const e of raw) {
    const p = FedEndpoint.safeParse(e);
    if (p.success) out.push(p.data);
  }
  return out.sort((a, b) => a.priority - b.priority);
}

/** A 44net endpoint is ARDC-attestable only under the delegated amateur namespace. */
export function is44netName(address: string): boolean {
  return /\.ampr\.org$/i.test(address);
}

// ---- link capabilities: negotiated live on sync links, static operator config on forward links ----

export const RateClass = z.enum(["hf", "vhf1200", "vhf9600", "ipLo", "ipHi"]);
export type RateClass = z.infer<typeof RateClass>;
export const Compression = z.enum(["none", "deflate", "deflateDict1"]);
export type Compression = z.infer<typeof Compression>;
export const RecordSetTier = z.enum(["beacon", "compact", "full"]);
export type RecordSetTier = z.infer<typeof RecordSetTier>;

export const LinkCaps = z.object({
  mode: z.enum(["sync", "forward"]),
  mtu: z
    .number()
    .int()
    .min(64)
    .max(1 << 24), // max bytes per frame/message the carrier passes
  rateClass: RateClass,
  batchMax: z.number().int().min(1).max(10000), // max records per exchange this end accepts
  compress: z.array(Compression).nonempty(),
  recordSet: RecordSetTier,
});
export type LinkCaps = z.infer<typeof LinkCaps>;

const RATE_ORDER: RateClass[] = ["hf", "vhf1200", "vhf9600", "ipLo", "ipHi"];
const TIER_ORDER: RecordSetTier[] = ["beacon", "compact", "full"];
const COMPRESS_PREF: Compression[] = ["deflateDict1", "deflate", "none"];

/** The record-set tier a rate class supports by default (operator policy may clamp further down). */
export function tierForRateClass(rc: RateClass): RecordSetTier {
  if (rc === "hf") return "beacon";
  if (rc === "vhf1200" || rc === "vhf9600") return "compact";
  return "full";
}

/**
 * Intersect both ends' advertised capabilities into the effective link profile: the slower rate
 * class, the smaller MTU/batch, the best mutually-supported compression, the smaller record set.
 * Returns null when the modes differ or no common compression exists — the link cannot be used.
 */
export function negotiateCaps(a: LinkCaps, b: LinkCaps): LinkCaps | null {
  if (a.mode !== b.mode) return null;
  const compress = COMPRESS_PREF.filter((c) => a.compress.includes(c) && b.compress.includes(c));
  if (!compress.length) return null;
  const rateClass = RATE_ORDER[Math.min(RATE_ORDER.indexOf(a.rateClass), RATE_ORDER.indexOf(b.rateClass))]!;
  const recordSet = TIER_ORDER[Math.min(TIER_ORDER.indexOf(a.recordSet), TIER_ORDER.indexOf(b.recordSet))]!;
  return {
    mode: a.mode,
    mtu: Math.min(a.mtu, b.mtu),
    rateClass,
    batchMax: Math.min(a.batchMax, b.batchMax),
    compress,
    recordSet,
  };
}
