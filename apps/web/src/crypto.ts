// SPDX-License-Identifier: AGPL-3.0-or-later
// Per-callsign device key (F0): an Ed25519 keypair held in the browser. The public key is
// registered to the callsign; finds are signed with the private key so authorship is portable and
// verifiable network-wide. Best-effort: on a browser without Ed25519 WebCrypto, signing is skipped
// and the find is simply logged unsigned.
import {
  authorshipMessage,
  accountActionMessage,
  ingestMessage,
  sha256Hex,
  stableStringify,
  type Authorship,
} from "@aprscaching/shared";

const PRIV = "acs.key.priv", // legacy: an *extractable* pkcs8 in localStorage (migrated away, see below)
  PUB = "acs.key.pub"; // the public key is not secret — a base64url string in localStorage is fine

const b64 = (buf: ArrayBuffer) => {
  let s = "";
  for (const x of new Uint8Array(buf)) s += String.fromCharCode(x);
  return btoa(s);
};
const b64u = (buf: ArrayBuffer) => b64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string) => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const o = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i);
  return o;
};

// SR-WEB: the private signing key lives in IndexedDB as a NON-extractable CryptoKey — an XSS on the
// origin can still *use* it while on the page, but (unlike the old extractable pkcs8 in localStorage)
// cannot export/exfiltrate the key material. IndexedDB structured-clones a CryptoKey and preserves
// its non-extractable flag.
const IDB_NAME = "acs-keys",
  IDB_STORE = "keys",
  IDB_KEY = "device-priv";
function idbOpen(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(key: string): Promise<CryptoKey | undefined> {
  const db = await idbOpen();
  try {
    return await new Promise((res, rej) => {
      const req = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(key);
      req.onsuccess = () => res(req.result as CryptoKey | undefined);
      req.onerror = () => rej(req.error);
    });
  } finally {
    db.close();
  }
}
async function idbPut(key: string, val: CryptoKey): Promise<void> {
  const db = await idbOpen();
  try {
    await new Promise<void>((res, rej) => {
      const req = db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE).put(val, key);
      req.onsuccess = () => res();
      req.onerror = () => rej(req.error);
    });
  } finally {
    db.close();
  }
}

let cached: { publicKey: string; priv: CryptoKey } | null = null;
let inflight: Promise<{ publicKey: string; priv: CryptoKey }> | null = null;

async function loadOrCreate(): Promise<{ publicKey: string; priv: CryptoKey }> {
  const storedPub = localStorage.getItem(PUB);
  const idbPriv = await idbGet(IDB_KEY).catch(() => undefined);
  if (storedPub && idbPriv) return { publicKey: storedPub, priv: idbPriv };

  // Migrate an existing extractable key: re-import the old localStorage pkcs8 as NON-extractable into
  // IndexedDB, then delete the extractable copy. Same key → no re-registration.
  const legacy = localStorage.getItem(PRIV);
  if (storedPub && legacy) {
    const priv = await crypto.subtle.importKey("pkcs8", unb64(legacy), { name: "Ed25519" }, false, ["sign"]);
    await idbPut(IDB_KEY, priv).catch(() => {});
    localStorage.removeItem(PRIV);
    return { publicKey: storedPub, priv };
  }

  // Fresh: generate, export the public key once, then persist ONLY a non-extractable private key.
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = b64u(await crypto.subtle.exportKey("raw", kp.publicKey));
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
  const priv = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  await idbPut(IDB_KEY, priv).catch(() => {});
  localStorage.setItem(PUB, publicKey);
  localStorage.removeItem(PRIV);
  return { publicKey, priv };
}

async function deviceKey(): Promise<{ publicKey: string; priv: CryptoKey }> {
  if (cached) return cached;
  // SR-WEB: coalesce concurrent callers (signAuthorship + devicePublicKey, etc.) so two racing calls
  // can't each generate a key and clobber the registered public key.
  if (!inflight)
    inflight = loadOrCreate()
      .then((k) => (cached = k))
      .finally(() => {
        inflight = null;
      });
  return inflight;
}

export interface AuthorSig {
  authorKey: string;
  authorSig: string;
  signedAt: number;
}

/** Sign the canonical authorship of a find. Returns undefined if the browser can't (no Ed25519). */
export async function signAuthorship(a: Authorship): Promise<AuthorSig | undefined> {
  try {
    const { publicKey, priv } = await deviceKey();
    const sig = await crypto.subtle.sign("Ed25519", priv, new TextEncoder().encode(authorshipMessage(a)));
    return { authorKey: publicKey, authorSig: b64u(sig), signedAt: a.at };
  } catch {
    return undefined;
  }
}

/** The device public key (creating one if needed), or null if unsupported. */
export async function devicePublicKey(): Promise<string | null> {
  try {
    return (await deviceKey()).publicKey;
  } catch {
    return null;
  }
}

export type SignedIngestHeaders = {
  "x-acs-callsign": string;
  "x-acs-key": string;
  "x-acs-sig": string;
  "x-acs-at": string;
};
/** Sign a browser RF ingest batch with the device key → headers, or undefined. */
export async function signIngest(callsign: string, packets: unknown[]): Promise<SignedIngestHeaders | undefined> {
  try {
    const { publicKey, priv } = await deviceKey();
    const at = Math.floor(Date.now() / 1000);
    const digest = await sha256Hex(stableStringify(packets));
    const sig = await crypto.subtle.sign(
      "Ed25519",
      priv,
      new TextEncoder().encode(ingestMessage({ callsign, at, count: packets.length, digest })),
    );
    return {
      "x-acs-callsign": callsign.toUpperCase(),
      "x-acs-key": publicKey,
      "x-acs-sig": b64u(sig),
      "x-acs-at": String(at),
    };
  } catch {
    return undefined;
  }
}

/** Sign a sensitive account action (export/delete/migrate) with the device key. */
export async function signAccountAction(
  action: string,
  callsign: string,
  instance: string,
): Promise<{ key: string; sig: string; at: number } | undefined> {
  try {
    const { publicKey, priv } = await deviceKey();
    const at = Math.floor(Date.now() / 1000);
    const sig = await crypto.subtle.sign(
      "Ed25519",
      priv,
      new TextEncoder().encode(accountActionMessage({ action, callsign, instance, at })),
    );
    return { key: publicKey, sig: b64u(sig), at };
  } catch {
    return undefined;
  }
}
