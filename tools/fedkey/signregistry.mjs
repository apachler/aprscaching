// SPDX-License-Identifier: AGPL-3.0-or-later
// Sign a federation instance registry (T4.2). Reads the entries JSON array on argv[2] (or stdin) and
// signs it with a registry-AUTHORITY key, emitting the values consumers set:
//   • FED_REGISTRY     — the signed document {entries,at,sig,signer}
//   • FED_REGISTRY_KEY — the authority public key (peers verify the registry against this)
//
//   node tools/fedkey/signregistry.mjs '[{"instance":"oe.net","url":"https://oe.aprscaching.net","key":"<pub>","operator":"OE8APR","aprsCall":"OE8APR-12"}]'
//
// Reuse one authority key across signings by passing it in AUTHORITY (base64 {pkcs8,pub}); else a fresh
// one is minted and printed. The registry binds each instance id to its key so a peer can't impersonate
// a known instance — consumers reject a /.well-known whose keys don't include the registry-bound key.

const stableStringify = (v) => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
};
const readStdin = () => new Promise((res) => { let s = ""; process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => res(s)); });

const raw = process.argv[2] ?? (await readStdin());
let entries;
try { entries = JSON.parse(raw); } catch { console.error("pass a JSON array of registry entries as argv[2] or on stdin"); process.exit(1); }
if (!Array.isArray(entries)) { console.error("entries must be a JSON array"); process.exit(1); }

let pkcs8, pub;
if (process.env.AUTHORITY) {
  ({ pkcs8, pub } = JSON.parse(Buffer.from(process.env.AUTHORITY, "base64").toString()));
} else {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", kp.privateKey)).toString("base64");
  pub = Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("base64url");
}
const priv = await crypto.subtle.importKey("pkcs8", Buffer.from(pkcs8, "base64"), { name: "Ed25519" }, false, ["sign"]);

const at = Math.floor(Date.now() / 1000);
const sig = Buffer.from(
  await crypto.subtle.sign("Ed25519", priv, new TextEncoder().encode(stableStringify({ at, entries })))
).toString("base64url");
const doc = { entries, at, sig, signer: pub };

if (process.argv.includes("--raw")) {
  process.stdout.write(JSON.stringify({ FED_REGISTRY: JSON.stringify(doc), FED_REGISTRY_KEY: pub }));
} else {
  console.log("FED_REGISTRY=" + JSON.stringify(doc) + "\n");
  console.log("FED_REGISTRY_KEY=" + pub + "  (peers set this to verify the registry)\n");
  if (!process.env.AUTHORITY)
    console.log("AUTHORITY (keep secret; reuse to re-sign)=" + Buffer.from(JSON.stringify({ pkcs8, pub })).toString("base64"));
}
