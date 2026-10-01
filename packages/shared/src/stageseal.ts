// SPDX-License-Identifier: MIT
/**
 * A multi-stage cache's NFC stage, sealed for offline packs. What unlocking the stage reveals (its
 * coordinates, clue and audio clue) is encrypted with a key derived from the stage's tag code, so a pack can
 * carry it and the finder's phone opens it by scanning the tag, with no connection. The server confirms the
 * unlock when the phone syncs, as it would have online.
 *
 * Anyone holding a pack can try codes offline, so a code is sealed only when it is long enough to make that
 * hopeless (STAGE_MIN_CODE_BITS); a shorter one leaves the stage online-only. Each guess costs a slow key
 * derivation (PBKDF2-SHA256, STAGE_KDF_ITERATIONS rounds, a random salt per stage). Geo stages are never
 * sealed: unlocking one needs a position check the phone alone cannot be trusted with.
 *
 * WebCrypto only, so it runs in the browser, Node, Bun and Workers alike.
 */

/** PBKDF2 rounds: the most Cloudflare Workers allow. */
export const STAGE_KDF_ITERATIONS = 100_000;
/** The least estimated entropy (bits) a tag code needs to be sealed into packs. */
export const STAGE_MIN_CODE_BITS = 40;

/** What unlocking a stage reveals. */
export interface StagePayload {
  lat: number | null;
  lon: number | null;
  clue: string | null;
  mediaUrl: string | null;
}

/** The sealed payload as a pack carries it (base64url fields). */
export interface SealedStage {
  v: 1;
  iter: number;
  salt: string;
  iv: string;
  data: string;
}

/** The comparison form of a tag code: trimmed, case-folded (tag serials and texts vary in case). */
export const normalizeStageCode = (code: string) => code.trim().toLowerCase();

/**
 * A rough upper bound of a code's entropy: its length times the bits of the character classes it uses
 * (digits, letters, other). A code of fewer than four distinct characters counts as none. It cannot see
 * that a code is a word, so owners are told to use the tag's serial or random characters.
 */
export function codeEntropyBits(code: string): number {
  const c = normalizeStageCode(code);
  if (new Set(c).size < 4) return 0;
  let alphabet = 0;
  if (/[0-9]/.test(c)) alphabet += 10;
  if (/[a-z]/.test(c)) alphabet += 26;
  if (/[^0-9a-z]/.test(c)) alphabet += 33;
  return Math.floor(c.length * Math.log2(alphabet));
}

const b64u = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64u = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function keyFor(code: string, salt: Uint8Array<ArrayBuffer>, iter: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(normalizeStageCode(code)),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: iter },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Seal a stage's payload under its tag code. */
export async function sealStage(
  code: string,
  payload: StagePayload,
  iter = STAGE_KDF_ITERATIONS,
): Promise<SealedStage> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await keyFor(code, salt, iter),
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return { v: 1, iter, salt: b64u(salt), iv: b64u(iv), data: b64u(new Uint8Array(data)) };
}

/** Open a sealed stage with a scanned or typed code; null when the code is not the stage's. */
export async function openSealedStage(code: string, sealed: SealedStage): Promise<StagePayload | null> {
  if (sealed.v !== 1) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64u(sealed.iv) },
      await keyFor(code, fromB64u(sealed.salt), sealed.iter),
      fromB64u(sealed.data),
    );
    return JSON.parse(new TextDecoder().decode(plain)) as StagePayload;
  } catch {
    return null; // the wrong code: AES-GCM's tag does not verify
  }
}
