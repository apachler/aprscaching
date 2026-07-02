// SPDX-License-Identifier: AGPL-3.0-or-later
// Generate an Ed25519 tool-author (or registry-authority) signing key — the key used to sign a tool.json
// manifest (docs/design/28 §7) or a signed tool registry. WebCrypto Ed25519, same algorithm as everywhere else.
//
//   node tools/toolkey/genkey.mjs           # human-readable (private base64 + public base64url)
//   node tools/toolkey/genkey.mjs --raw     # just the private base64 value (feed to sign.mjs)
//
// The PRIVATE value (base64(JSON{pkcs8,pub})) signs; the PUBLIC value (base64url raw) goes in the
// manifest `pubkey` and/or is pinned as the registry authority. Never commit a private key.

const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", kp.privateKey)).toString("base64");
const pub = Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("base64url");
const priv = Buffer.from(JSON.stringify({ pkcs8, pub })).toString("base64");

if (process.argv.includes("--raw")) {
  process.stdout.write(priv);
} else {
  console.log("TOOL_PRIVATE_KEY (sign with this — never commit):\n" + priv);
  console.log("\npublic key (Ed25519, base64url) — put in the manifest `pubkey` / pin as registry authority:\n" + pub);
}
