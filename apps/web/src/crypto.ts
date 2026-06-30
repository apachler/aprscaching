// Per-callsign device key (F0): an Ed25519 keypair held in the browser. The public key is
// registered to the callsign; finds are signed with the private key so authorship is portable and
// verifiable network-wide. Best-effort: on a browser without Ed25519 WebCrypto, signing is skipped
// and the find is simply logged unsigned.
import { authorshipMessage, accountActionMessage, ingestMessage, sha256Hex, stableStringify, type Authorship } from "@aprsweb/shared";

const PRIV = "acs.key.priv", PUB = "acs.key.pub";

const b64 = (buf: ArrayBuffer) => { let s = ""; for (const x of new Uint8Array(buf)) s += String.fromCharCode(x); return btoa(s); };
const b64u = (buf: ArrayBuffer) => b64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string) => { const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/")); const o = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o; };

let cached: { publicKey: string; priv: CryptoKey } | null = null;

async function deviceKey(): Promise<{ publicKey: string; priv: CryptoKey }> {
  if (cached) return cached;
  const storedPub = localStorage.getItem(PUB), storedPriv = localStorage.getItem(PRIV);
  if (storedPub && storedPriv) {
    const priv = await crypto.subtle.importKey("pkcs8", unb64(storedPriv), { name: "Ed25519" }, false, ["sign"]);
    return (cached = { publicKey: storedPub, priv });
  }
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const publicKey = b64u(await crypto.subtle.exportKey("raw", kp.publicKey));
  localStorage.setItem(PRIV, pkcs8);
  localStorage.setItem(PUB, publicKey);
  return (cached = { publicKey, priv: kp.privateKey });
}

export interface AuthorSig { authorKey: string; authorSig: string; signedAt: number }

/** Sign the canonical authorship of a find. Returns undefined if the browser can't (no Ed25519). */
export async function signAuthorship(a: Authorship): Promise<AuthorSig | undefined> {
  try {
    const { publicKey, priv } = await deviceKey();
    const sig = await crypto.subtle.sign("Ed25519", priv, new TextEncoder().encode(authorshipMessage(a)));
    return { authorKey: publicKey, authorSig: b64u(sig), signedAt: a.at };
  } catch { return undefined; }
}

/** The device public key (creating one if needed), or null if unsupported. */
export async function devicePublicKey(): Promise<string | null> {
  try { return (await deviceKey()).publicKey; } catch { return null; }
}

export type SignedIngestHeaders = { "x-acs-callsign": string; "x-acs-key": string; "x-acs-sig": string; "x-acs-at": string };
/** Sign a browser RF ingest batch with the device key (docs/16 H1.5) → headers, or undefined. */
export async function signIngest(callsign: string, packets: unknown[]): Promise<SignedIngestHeaders | undefined> {
  try {
    const { publicKey, priv } = await deviceKey();
    const at = Math.floor(Date.now() / 1000);
    const digest = await sha256Hex(stableStringify(packets));
    const sig = await crypto.subtle.sign("Ed25519", priv, new TextEncoder().encode(ingestMessage({ callsign, at, count: packets.length, digest })));
    return { "x-acs-callsign": callsign.toUpperCase(), "x-acs-key": publicKey, "x-acs-sig": b64u(sig), "x-acs-at": String(at) };
  } catch { return undefined; }
}

/** Sign a sensitive account action (export/delete/migrate) with the device key. */
export async function signAccountAction(action: string, callsign: string, instance: string): Promise<{ key: string; sig: string; at: number } | undefined> {
  try {
    const { publicKey, priv } = await deviceKey();
    const at = Math.floor(Date.now() / 1000);
    const sig = await crypto.subtle.sign("Ed25519", priv, new TextEncoder().encode(accountActionMessage({ action, callsign, instance, at })));
    return { key: publicKey, sig: b64u(sig), at };
  } catch { return undefined; }
}
