// SPDX-License-Identifier: AGPL-3.0-or-later
// Print a federation key's fingerprint: the first 16 hex digits of SHA-256 over the raw Ed25519 public key, the value
// two sysops compare before they trust each other, and the `#<fingerprint>` a FED_PEERS entry pins.
//
//   node tools/fedkey/fingerprint.mjs <public key>        # raw Ed25519, base64url (the descriptor's publicKey)
//   node tools/fedkey/fingerprint.mjs --key <FED_PRIVATE_KEY value>
//   node tools/fedkey/fingerprint.mjs --url https://aprs.example.net
//   add --raw for the bare 16 digits, without the grouped form
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const raw = args.includes("--raw");
const rest = args.filter((a) => a !== "--raw");

async function publicKey() {
  if (rest[0] === "--key") return JSON.parse(Buffer.from(rest[1] ?? "", "base64").toString()).pub;
  if (rest[0] === "--url") {
    const base = (rest[1] ?? "").replace(/\/+$/, "");
    const wk = await (await fetch(`${base}/.well-known/aprscaching`)).json();
    if (!wk.signed || !wk.publicKey) throw new Error(`${base} publishes no signing key`);
    return wk.publicKey;
  }
  return rest[0];
}

const pub = await publicKey().catch((e) => {
  console.error(e.message);
  process.exit(2);
});
if (!pub || !/^[A-Za-z0-9_-]{43}$/.test(pub)) {
  console.error("usage: fingerprint.mjs <public key> | --key <FED_PRIVATE_KEY> | --url <base URL> [--raw]");
  process.exit(2);
}
const hex = createHash("sha256").update(Buffer.from(pub, "base64url")).digest("hex").slice(0, 16);
process.stdout.write(raw ? hex : `${hex.match(/.{4}/g).join(" ")}\n`);
