// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fedcbor.ts — the gateway's binding of the CBOR federation wire format (packages/shared fedwire) to
 * this instance's Ed25519 key. A record signed here is a self-contained frame whose authenticity
 * lives entirely in its bytes: any transport (HTTP/44net sync, an AX.25/NET-ROM circuit, BBS
 * store-and-forward) carries the frame verbatim, and any receiver verifies it against the origin's
 * published key set — the path a frame took never enters the trust decision.
 */
import type { Env } from "./env.js";
import {
  encodeFedPayload,
  decodeFedFrame,
  encodeFedFrame,
  fedSigningBytes,
  type FedRecord,
  type FedFrame,
} from "@aprscaching/shared";
import { signRaw, importVerifyKey } from "./federation.js";

/** Sign a record with the instance key into a wire frame, or null when no key is configured. */
export async function signFedRecord(env: Env, record: FedRecord): Promise<Uint8Array | null> {
  const payload = encodeFedPayload(record);
  const signed = await signRaw(env, fedSigningBytes(payload));
  if (!signed) return null;
  return encodeFedFrame(payload, signed.publicX, signed.sig);
}

/**
 * Verify a wire frame against the origin's allowed key set (its active published keys). Returns the
 * verified frame, or null on ANY failure — malformed bytes, a signer key outside the allowed set, or
 * a bad signature. The signature is checked over the received payload bytes verbatim, never a
 * re-encode, so codec drift can't silently accept a forged record.
 */
export async function verifyFedFrame(bytes: Uint8Array, allowedKeys: readonly string[]): Promise<FedFrame | null> {
  let frame: FedFrame;
  try {
    frame = decodeFedFrame(bytes);
  } catch {
    return null;
  }
  if (!allowedKeys.includes(frame.signerKey)) return null; // key binding: only the origin's published keys count
  try {
    const key = await importVerifyKey(frame.signerKey);
    const ok = await crypto.subtle.verify("Ed25519", key, frame.sig, fedSigningBytes(frame.payload));
    return ok ? frame : null;
  } catch {
    return null;
  }
}
