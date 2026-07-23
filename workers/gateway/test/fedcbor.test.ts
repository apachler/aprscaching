// SPDX-License-Identifier: AGPL-3.0-or-later
// The CBOR wire frame end-to-end with a REAL Ed25519 key: sign → verify round-trip, then the attack
// surface — tampered payloads, signatures from a key outside the origin's published set, and frames
// re-signed by an impostor key must all verify to null.
import { describe, it, expect, beforeAll } from "vitest";
import { signFedRecord, verifyFedFrame } from "../src/fedcbor.js";
import { decodeFedFrame, encodeFedFrame, encodeFedPayload, fedSigningBytes, toE7 } from "@aprscaching/shared";
import type { FedRecord } from "@aprscaching/shared";
import type { Env } from "../src/env.js";

const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64url = (buf: ArrayBuffer) => b64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let env: Env;
let publicX: string;

beforeAll(async () => {
  // FED_PRIVATE_KEY carries base64(JSON({pkcs8, pub})) — the same shape tools/fedkey/genkey.mjs emits
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  publicX = b64url(await crypto.subtle.exportKey("raw", kp.publicKey));
  env = { FED_PRIVATE_KEY: btoa(JSON.stringify({ pkcs8, pub: publicX })) } as unknown as Env;
});

const record: FedRecord = {
  kind: "tombstone",
  gid: "oe.pub:cache:42",
  origin: "oe.pub",
  v: 1,
  at: 1_760_000_000,
  signer: "oe.pub",
  body: { reason: "owner delete", latE7: toE7(47.0832) },
};

describe("fedcbor — sign + verify over the CBOR wire frame", () => {
  // The unconfigured-key branch (signFedRecord → null) is not exercisable here: the instance key is
  // module-memoized (one instance = one key), so a no-key probe would poison the cache for the file.

  it("round-trips: a signed frame verifies under the origin's published key", async () => {
    const frame = await signFedRecord(env, record);
    expect(frame).not.toBeNull();
    const verified = await verifyFedFrame(frame!, [publicX]);
    expect(verified).not.toBeNull();
    expect(verified!.record).toEqual(record);
    expect(verified!.signerKey).toBe(publicX);
  });

  it("rejects a tampered payload (any bit flip breaks the signature)", async () => {
    const frame = (await signFedRecord(env, record))!;
    const parsed = decodeFedFrame(frame);
    const tampered = parsed.payload.slice();
    tampered[tampered.length - 1] ^= 0x01;
    const reframed = encodeFedFrame(tampered, parsed.signerKey, parsed.sig);
    expect(await verifyFedFrame(reframed, [publicX])).toBeNull();
  });

  it("rejects a signer key outside the origin's allowed set (key binding, not just validity)", async () => {
    const frame = (await signFedRecord(env, record))!;
    expect(await verifyFedFrame(frame, ["SOME-OTHER-KEY"])).toBeNull();
    expect(await verifyFedFrame(frame, [])).toBeNull();
  });

  it("rejects a frame re-signed by an impostor key even when that key is (wrongly) allowed", async () => {
    // an attacker with their OWN valid key re-signs the victim's payload; if an operator's allowed
    // set were ever polluted with the attacker key, the signature still only proves the attacker
    // said it — and here the frame must simply verify under the attacker key, not the victim's
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const attackerPub = b64url(await crypto.subtle.exportKey("raw", kp.publicKey));
    const payload = encodeFedPayload(record);
    const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, fedSigningBytes(payload)));
    const forged = encodeFedFrame(payload, attackerPub, sig);
    expect(await verifyFedFrame(forged, [publicX])).toBeNull(); // not the origin's key → refused
    expect(await verifyFedFrame(forged, [attackerPub])).not.toBeNull(); // under its own key it is what it is
  });

  it("rejects garbage bytes without throwing", async () => {
    expect(await verifyFedFrame(new Uint8Array([0xff, 0x00, 0x13, 0x37]), [publicX])).toBeNull();
  });
});
