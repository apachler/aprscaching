// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * base64url (RFC 4648 §5) for the browser: WebAuthn challenges and credentials, Ed25519 keys and
 * signatures, and VAPID keys all travel in it. Encoding omits the `=` padding; decoding accepts
 * either alphabet, padded or not.
 */

export function toB64u(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64u(s: string): Uint8Array<ArrayBuffer> {
  const std = s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
