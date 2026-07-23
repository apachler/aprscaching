// SPDX-License-Identifier: AGPL-3.0-or-later
// Generate an Ed25519 federation signing key (WebCrypto; same algorithm the gateway uses).
// The key is emitted as base64(JWK) — the JWK carries both the private (d) and public (x) parts,
// so the instance can sign and publish its public key from one value.
//
//   node tools/fedkey/genkey.mjs           # human-readable
//   node tools/fedkey/genkey.mjs --raw     # just the base64 value (for FED_PRIVATE_KEY)
//
// Set it as a secret, never commit it:
//   wrangler secret put FED_PRIVATE_KEY        (Cloudflare)
//   export FED_PRIVATE_KEY=...                 (Node self-host)

const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
// PKCS8 private import is portable across workerd + Node; carry the raw public key alongside.
const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", kp.privateKey)).toString("base64");
const pub = Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("base64url");
const b64 = Buffer.from(JSON.stringify({ pkcs8, pub })).toString("base64");

if (process.argv.includes("--raw")) {
  process.stdout.write(b64);
} else {
  console.log("FED_PRIVATE_KEY (set as a secret, never commit):\n" + b64);
  console.log("\npublic key (Ed25519, base64url): " + pub);
  console.log("The gateway publishes the public key at /.well-known/aprscaching for peers to verify.");
}
