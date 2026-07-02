// Sign a tool.json manifest OR a tool registry with a TOOL_PRIVATE_KEY (from genkey.mjs). The canonical
// bytes match packages/tools/src/registry.ts EXACTLY (stableStringify; manifest omits `signature`, registry
// signs its `entries`) so the app verifies what this signs.
//
//   TOOL_PRIVATE_KEY=... node tools/toolkey/sign.mjs manifest path/to/tool.json
//   TOOL_PRIVATE_KEY=... node tools/toolkey/sign.mjs registry path/to/registry.json   # entries[] or {entries}
import fs from "node:fs";

const stable = (v) => v === null || typeof v !== "object" ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(stable).join(",")}]`
  : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;

const [, , kind, file] = process.argv;
const privB64 = process.env.TOOL_PRIVATE_KEY;
if (!kind || !file || !privB64) { console.error("usage: TOOL_PRIVATE_KEY=... node tools/toolkey/sign.mjs <manifest|registry> <file>"); process.exit(2); }

const { pkcs8, pub } = JSON.parse(Buffer.from(privB64, "base64").toString());
const key = await crypto.subtle.importKey("pkcs8", Buffer.from(pkcs8, "base64"), { name: "Ed25519" }, false, ["sign"]);
const signB64 = async (bytes) => Buffer.from(await crypto.subtle.sign("Ed25519", key, bytes)).toString("base64");
const enc = (s) => new TextEncoder().encode(s);

const doc = JSON.parse(fs.readFileSync(file, "utf8"));
let out;
if (kind === "manifest") {
  const m = { ...doc, pubkey: pub };
  delete m.signature;
  out = { ...m, signature: await signB64(enc(stable(m))) };
} else if (kind === "registry") {
  const entries = Array.isArray(doc) ? doc : doc.entries;
  if (!Array.isArray(entries)) { console.error("registry file must be an entries[] array or { entries }"); process.exit(2); }
  out = { entries, authority: pub, sig: await signB64(enc(stable(entries))) };
} else { console.error("kind must be 'manifest' or 'registry'"); process.exit(2); }

fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`signed ${kind} -> ${file}  (authority/pubkey base64url: ${pub})`);
