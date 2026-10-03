// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * gatewayauth.ts — how this box proves itself to its gateway. With BOX_ID and BOX_KEY (set by enrolling
 * with a one-time code, enroll.ts) it signs every gateway request with its own Ed25519 key; without them it
 * sends the shared INGEST_SECRET. The rest of the ingest marks a gateway request by its x-ingest-secret
 * header and sends it through gatewayFetch, which swaps that header for the signature when the box has a key.
 *
 * The signature covers the method, the path with its query, the time, a random nonce and the body's SHA-256
 * (boxRequestMessage in packages/shared), so a request cannot be altered or sent again.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { SIG_DOMAIN, boxEnrollMessage, boxRequestMessage } from "@aprscaching/shared";

export interface BoxKey {
  box: string;
  key: KeyObject;
  /** The raw public key, base64url, as the gateway stores it. */
  publicKey: string;
}

const b64url = (b: Buffer) => b.toString("base64url");

function rawPublicKey(priv: KeyObject): string {
  const jwk = createPublicKey(priv).export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("not an Ed25519 key");
  return jwk.x;
}

/** A fresh key pair: BOX_KEY (the private key, PKCS#8 in base64url) and its raw public key. */
export function newBoxKey(): { boxKey: string; publicKey: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  return {
    boxKey: b64url(privateKey.export({ format: "der", type: "pkcs8" }) as Buffer),
    publicKey: rawPublicKey(privateKey),
  };
}

/** The box's key from BOX_ID and BOX_KEY, or null when the box uses the shared secret. */
export function loadBoxKey(env: Record<string, string | undefined>): BoxKey | null {
  const boxKey = env.BOX_KEY?.trim();
  if (!boxKey) return null;
  const box = env.BOX_ID?.trim();
  if (!box) throw new Error("BOX_KEY is set without BOX_ID: enroll again, or set the id the box enrolled with");
  const key = createPrivateKey({ key: Buffer.from(boxKey, "base64url"), format: "der", type: "pkcs8" });
  return { box, key, publicKey: rawPublicKey(key) };
}

function bodyBytes(body: BodyInit | null | undefined): Buffer {
  if (body == null) return Buffer.alloc(0);
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new Error("a signed gateway request needs a string or byte body");
}

/** The headers that sign one request. */
export function signedHeaders(k: BoxKey, method: string, url: string, body?: BodyInit | null): Record<string, string> {
  const u = new URL(url);
  const at = Math.floor(Date.now() / 1000);
  const nonce = b64url(randomBytes(16));
  const digest = createHash("sha256").update(bodyBytes(body)).digest("hex");
  const message = boxRequestMessage({ box: k.box, method, path: u.pathname + u.search, at, nonce, digest });
  const sig = sign(null, Buffer.from(SIG_DOMAIN.box + message), k.key);
  return { "x-box-id": k.box, "x-box-at": String(at), "x-box-nonce": nonce, "x-box-sig": b64url(sig) };
}

/** The enrollment request: the code, the box's id and public key, signed with the new key. */
export function enrollBody(k: BoxKey, code: string, label?: string) {
  const normalised = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const at = Math.floor(Date.now() / 1000);
  const message = boxEnrollMessage({ box: k.box, key: k.publicKey, code: normalised, at });
  const sig = b64url(sign(null, Buffer.from(SIG_DOMAIN.boxEnroll + message), k.key));
  return { code: normalised, box: k.box, key: k.publicKey, at, sig, ...(label ? { label } : {}) };
}

let active: BoxKey | null = null;

/** Sign gateway requests with this key from now on (null: send the shared secret). */
export function useBoxKey(k: BoxKey | null): void {
  active = k;
}

/** How long a gateway request may take before it is abandoned and counted as a failure. */
export const GATEWAY_TIMEOUT_MS = 20_000;

/**
 * fetch for gateway requests. A request carrying x-ingest-secret goes out signed instead when this box has a
 * key; every other request, and every request of a box on the shared secret, goes out unchanged. A request
 * without its own signal is abandoned after GATEWAY_TIMEOUT_MS, so a gateway that accepts the connection and
 * never answers cannot hold a poll loop forever.
 */
export const gatewayFetch: typeof fetch = (input, init = {}) => {
  const headers = new Headers(init.headers);
  if (active && headers.has("x-ingest-secret")) {
    if (input instanceof Request) throw new Error("gatewayFetch signs a URL and an init, not a Request");
    headers.delete("x-ingest-secret");
    for (const [k, v] of Object.entries(signedHeaders(active, init.method ?? "GET", String(input), init.body)))
      headers.set(k, v);
  }
  return fetch(input, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(GATEWAY_TIMEOUT_MS) });
};
