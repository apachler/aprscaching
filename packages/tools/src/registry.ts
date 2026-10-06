// SPDX-License-Identifier: MIT
/**
 * registry.ts — signed-manifest verification + the signed tool registry. A tool.json is
 * Ed25519-signed by its author: the manifest carries a raw public key (`pubkey`, base64url) and a detached
 * `signature` (base64) over the canonical manifest (every field except `signature`). Verifying proves the
 * manifest wasn't tampered and was signed by whoever holds that key — INTEGRITY. IDENTITY comes from the
 * **registry**: an authority-signed list binding each tool `name`→`pubkey`. The app pins the authority key,
 * so a registry-listed tool whose manifest key matches its entry is "verified"; everything else is
 * "self-signed" (valid sig, unknown key) or "unsigned" (refused). The signed `entrySha256` ties the script bytes
 * to the signature (checkEntryHash). WebCrypto Ed25519 — same code in browser, Worker,
 * Node 20+, Bun. Dependency-free + MIT (this package must stay embeddable).
 */
import type { ToolManifest } from "./manifest.js";

// ---- tiny canonical JSON (byte-for-byte agreement; mirrors packages/shared canon, inlined to stay dep-free) ----
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  // An unset field is left out, as JSON.stringify leaves it out: the validated manifest carries every optional
  // field, set or not, while an author signs the file as written, so both sides must serialise the same keys.
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

// ---- base64 / base64url <-> bytes (browser + Worker + Node/Bun globals) ----
export function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/"));
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}
export function bytesToB64(bytes: Uint8Array, url = false): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  const b64 = btoa(s);
  return url ? b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : b64;
}
/** A plain ArrayBuffer view of a Uint8Array — what WebCrypto's BufferSource params want (avoids the
 *  Uint8Array<ArrayBufferLike> vs ArrayBuffer lib variance across TS versions). */
const buf = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/** The exact bytes an author signs: the canonical manifest with `signature` removed (pubkey stays in). */
export function manifestSigningBytes(m: ToolManifest | Record<string, unknown>): Uint8Array {
  const rest: Record<string, unknown> = { ...m };
  delete rest.signature;
  return new TextEncoder().encode(stableStringify(rest));
}

const importVerifyKey = (rawB64url: string): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", buf(b64ToBytes(rawB64url)), { name: "Ed25519" }, false, ["verify"]);

/** Signature outcome for a manifest. `invalid` and `unsigned` MUST both block the import. */
export type ManifestSig = "unsigned" | "valid" | "invalid";

/**
 * Check a manifest's own signature against its self-carried pubkey (integrity, not identity). Pass the manifest
 * as fetched, before `validateManifest`: validation fills in defaults and normalises fields, and the author signed
 * the file as written.
 */
export async function checkManifestSignature(m: ToolManifest | Record<string, unknown>): Promise<ManifestSig> {
  if (typeof m.signature !== "string" || typeof m.pubkey !== "string" || !m.signature || !m.pubkey) return "unsigned";
  try {
    const key = await importVerifyKey(m.pubkey);
    const ok = await crypto.subtle.verify("Ed25519", key, buf(b64ToBytes(m.signature)), buf(manifestSigningBytes(m)));
    return ok ? "valid" : "invalid";
  } catch {
    return "invalid";
  }
}

/** SHA-256 of `bytes`, standard base64: the form a manifest's `entrySha256` takes. */
export async function sha256B64(bytes: Uint8Array): Promise<string> {
  return bytesToB64(new Uint8Array(await crypto.subtle.digest("SHA-256", buf(bytes))));
}

/**
 * Whether the script bytes fetched from a manifest's `entry` are the ones it pins in `entrySha256`. The manifest's
 * signature covers `entrySha256`, so this ties the code that runs to the signer. `missing` and `mismatch` MUST
 * refuse the tool: whoever serves the script (the author's host, a mirror, the instance's carrier) can otherwise
 * swap it without breaking the signature.
 */
export type EntryHashCheck = "ok" | "missing" | "mismatch";
export async function checkEntryHash(m: { entrySha256?: unknown }, script: Uint8Array): Promise<EntryHashCheck> {
  if (typeof m.entrySha256 !== "string" || !m.entrySha256) return "missing";
  return (await sha256B64(script)) === m.entrySha256 ? "ok" : "mismatch";
}

/** Sign a manifest with an Ed25519 private key (authoring/tests) — returns the manifest with `signature` set. */
export async function signManifest(m: ToolManifest, priv: CryptoKey): Promise<ToolManifest> {
  const sig = await crypto.subtle.sign("Ed25519", priv, buf(manifestSigningBytes({ ...m, signature: undefined })));
  return { ...m, signature: bytesToB64(new Uint8Array(sig)) };
}

// ---- the signed tool registry (marketplace index) ----
export interface RegistryEntry {
  name: string;
  title: string;
  author: string;
  version: string;
  pubkey: string; // the author key this tool's manifest MUST match to be "verified"
  entry: string; // the tool.json's URL; a relative one resolves against the registry's own URL
  description?: string;
}
/** An authority-signed registry: `sig` (base64) covers the canonical `entries`; `authority` is its pubkey. */
export interface SignedRegistry {
  entries: RegistryEntry[];
  authority: string;
  sig: string;
}

export function registrySigningBytes(entries: RegistryEntry[]): Uint8Array {
  return new TextEncoder().encode(stableStringify(entries));
}

/** Verify a registry against a PINNED authority key (base64url). Rejects a forged/unsigned/mismatched doc. */
export async function verifyRegistry(reg: SignedRegistry, pinnedAuthorityB64url: string): Promise<boolean> {
  if (!reg || !Array.isArray(reg.entries) || reg.authority !== pinnedAuthorityB64url || !reg.sig) return false;
  try {
    const key = await importVerifyKey(reg.authority);
    return await crypto.subtle.verify("Ed25519", key, buf(b64ToBytes(reg.sig)), buf(registrySigningBytes(reg.entries)));
  } catch {
    return false;
  }
}

/**
 * An authority key's fingerprint, for comparing with the one its publisher gives: the first 64 bits of SHA-256
 * over the raw Ed25519 key, as four groups of four hex digits (`3f2a 9c01 bb7e 4d10`), the form federation keys
 * use too. Null for a key that is not 32 bytes of base64url.
 */
export async function authorityFingerprint(rawB64url: string): Promise<string | null> {
  let raw: Uint8Array;
  try {
    raw = b64ToBytes(rawB64url);
  } catch {
    return null;
  }
  if (raw.length !== 32) return null;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf(raw)));
  const hex = [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex.match(/.{4}/g)!.join(" ");
}

/** What a registry file shows before its key is pinned: who signed it, and a sample of what it lists. */
export interface RegistryPreview {
  authority: string;
  fingerprint: string;
  count: number;
  titles: string[];
}

/**
 * Look at a registry file before its key is pinned. The file must verify under the key it names itself, which
 * proves only that it is intact; whether that key is the publisher's is for the person to confirm by comparing
 * the fingerprint. Nothing here trusts the key.
 */
export async function previewRegistry(
  doc: unknown,
  sample = 5,
): Promise<{ ok: true; preview: RegistryPreview } | { ok: false; error: string }> {
  const reg = doc as SignedRegistry;
  if (!reg || typeof reg !== "object" || !Array.isArray(reg.entries) || typeof reg.authority !== "string")
    return { ok: false, error: "not a tool registry: it needs entries, authority and sig" };
  const fingerprint = await authorityFingerprint(reg.authority);
  if (!fingerprint) return { ok: false, error: "the registry's authority is not an Ed25519 public key" };
  if (!(await verifyRegistry(reg, reg.authority)))
    return { ok: false, error: "the registry's signature does not verify under the key it names" };
  return {
    ok: true,
    preview: {
      authority: reg.authority,
      fingerprint,
      count: reg.entries.length,
      titles: reg.entries.slice(0, sample).map((e) => String(e.title ?? e.name)),
    },
  };
}

/**
 * A fetched registry checked against its pinned key: `ok` when the pinned key signed it, `key-changed` when the
 * file names another key (refused until the person confirms the new one), `invalid` when the file names the
 * pinned key but its signature fails, or is not a registry.
 */
export type PinnedRegistryState = "ok" | "key-changed" | "invalid";
export async function checkPinnedRegistry(doc: unknown, pinned: string): Promise<PinnedRegistryState> {
  const reg = doc as SignedRegistry;
  if (!reg || typeof reg !== "object" || !Array.isArray(reg.entries)) return "invalid";
  if (typeof reg.authority === "string" && reg.authority !== pinned) return "key-changed";
  return (await verifyRegistry(reg, pinned)) ? "ok" : "invalid";
}

/** Sign a registry (authoring/tests). */
export async function signRegistry(
  entries: RegistryEntry[],
  authorityPub: string,
  priv: CryptoKey,
): Promise<SignedRegistry> {
  const sig = await crypto.subtle.sign("Ed25519", priv, buf(registrySigningBytes(entries)));
  return { entries, authority: authorityPub, sig: bytesToB64(new Uint8Array(sig)) };
}

/**
 * The registry entry a fetched manifest stands for: the entry with its `name` whose `entry` URL is the URL the
 * manifest was fetched from. An entry's relative `entry` (`/tools/hello/tool.json`) resolves against
 * `registryUrl`, the address the registry was fetched from; without it only absolute entries match. A copy of a
 * listed manifest served from another URL matches no entry — its relative script `entry` resolves against that
 * other URL, so it runs another site's script and is trusted as any other signed manifest is
 * (trust-on-first-use), never as the listed tool.
 */
export function registryEntryFor(
  entries: readonly RegistryEntry[],
  name: string,
  manifestUrl: string,
  registryUrl?: string,
): RegistryEntry | undefined {
  const href = (u: string, base?: string): string | null => {
    try {
      return new URL(u, base).href;
    } catch {
      return null;
    }
  };
  const fetched = href(manifestUrl);
  if (!fetched) return undefined;
  return entries.find((e) => e.name === name && href(e.entry, registryUrl) === fetched);
}

/** Overall trust of a fetched manifest given signature status + registry match + a TOFU pin. */
export type ToolTrust = "verified" | "known" | "self-signed" | "unsigned" | "invalid" | "key-changed";
export function resolveTrust(
  sig: ManifestSig,
  opts: { registryPubkey?: string; pinnedPubkey?: string; pubkey?: string },
): ToolTrust {
  if (sig === "invalid") return "invalid";
  if (sig === "unsigned") return "unsigned";
  // sig === valid from here
  if (opts.registryPubkey) return opts.registryPubkey === opts.pubkey ? "verified" : "key-changed";
  if (opts.pinnedPubkey) return opts.pinnedPubkey === opts.pubkey ? "known" : "key-changed";
  return "self-signed";
}
