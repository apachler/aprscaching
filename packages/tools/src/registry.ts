// SPDX-License-Identifier: MIT
/**
 * registry.ts — signed-manifest verification + the signed tool registry. A tool.json MAY be
 * Ed25519-signed by its author: the manifest carries a raw public key (`pubkey`, base64url) and a detached
 * `signature` (base64) over the canonical manifest (every field except `signature`). Verifying proves the
 * manifest wasn't tampered and was signed by whoever holds that key — INTEGRITY. IDENTITY comes from the
 * **registry**: an authority-signed list binding each tool `name`→`pubkey`. The app pins the authority key,
 * so a registry-listed tool whose manifest key matches its entry is "verified"; everything else is
 * "self-signed" (valid sig, unknown key) or "unsigned". WebCrypto Ed25519 — same code in browser, Worker,
 * Node 20+, Bun. Dependency-free + MIT (this package must stay embeddable).
 */
import type { ToolManifest } from "./manifest.js";

// ---- tiny canonical JSON (byte-for-byte agreement; mirrors packages/shared canon, inlined to stay dep-free) ----
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
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
export function manifestSigningBytes(m: ToolManifest): Uint8Array {
  const rest: Record<string, unknown> = { ...m };
  delete rest.signature;
  return new TextEncoder().encode(stableStringify(rest));
}

const importVerifyKey = (rawB64url: string): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", buf(b64ToBytes(rawB64url)), { name: "Ed25519" }, false, ["verify"]);

/** Signature outcome for a manifest. `invalid` MUST block the import; `unsigned` is allowed-with-warning. */
export type ManifestSig = "unsigned" | "valid" | "invalid";

/** Check a manifest's own signature against its self-carried pubkey (integrity, not identity). */
export async function checkManifestSignature(m: ToolManifest): Promise<ManifestSig> {
  if (!m.signature || !m.pubkey) return "unsigned";
  try {
    const key = await importVerifyKey(m.pubkey);
    const ok = await crypto.subtle.verify("Ed25519", key, buf(b64ToBytes(m.signature)), buf(manifestSigningBytes(m)));
    return ok ? "valid" : "invalid";
  } catch {
    return "invalid";
  }
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
  entry: string; // absolute URL to the tool.json
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

/** Sign a registry (authoring/tests). */
export async function signRegistry(
  entries: RegistryEntry[],
  authorityPub: string,
  priv: CryptoKey,
): Promise<SignedRegistry> {
  const sig = await crypto.subtle.sign("Ed25519", priv, buf(registrySigningBytes(entries)));
  return { entries, authority: authorityPub, sig: bytesToB64(new Uint8Array(sig)) };
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
