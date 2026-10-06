// SPDX-License-Identifier: AGPL-3.0-or-later
// Sign a tool.json manifest OR a tool registry with a TOOL_PRIVATE_KEY (from genkey.mjs). The canonical
// bytes match packages/tools/src/registry.ts EXACTLY (stableStringify; manifest omits `signature`, registry
// signs `{ format, entries }`) so the app verifies what this signs. Signing a manifest first sets `entrySha256`, the
// SHA-256 of its entry script: the file `entry` names next to the manifest (default `tool.js`), or the file given
// as the third argument when `entry` is an absolute URL or path. The app refuses a script whose bytes differ.
//
//   TOOL_PRIVATE_KEY=... node tools/toolkey/sign.mjs manifest path/to/tool.json [path/to/entry.js]
//   TOOL_PRIVATE_KEY=... node tools/toolkey/sign.mjs registry path/to/registry.json   # entries[] or {entries}
import fs from "node:fs";
import path from "node:path";

const stable = (v) =>
  v === null || typeof v !== "object"
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(stable).join(",")}]`
      : `{${Object.keys(v)
          .filter((k) => v[k] !== undefined)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
          .join(",")}}`;

const [, , kind, file, entryFile] = process.argv;
const privB64 = process.env.TOOL_PRIVATE_KEY;
if (!kind || !file || !privB64) {
  console.error("usage: TOOL_PRIVATE_KEY=... node tools/toolkey/sign.mjs <manifest|registry> <file>");
  process.exit(2);
}

const { pkcs8, pub } = JSON.parse(Buffer.from(privB64, "base64").toString());
const key = await crypto.subtle.importKey("pkcs8", Buffer.from(pkcs8, "base64"), { name: "Ed25519" }, false, ["sign"]);
const signB64 = async (bytes) => Buffer.from(await crypto.subtle.sign("Ed25519", key, bytes)).toString("base64");
const enc = (s) => new TextEncoder().encode(s);

const doc = JSON.parse(fs.readFileSync(file, "utf8"));
let out;
if (kind === "manifest") {
  const entry = typeof doc.entry === "string" ? doc.entry : "tool.js";
  const script = entryFile ?? (/^[a-z][a-z0-9+.-]*:|^\//i.test(entry) ? null : path.join(path.dirname(file), entry));
  if (!script || !fs.existsSync(script)) {
    console.error(`cannot read the entry script ${script ?? entry}: give its file as the third argument`);
    process.exit(2);
  }
  const entrySha256 = Buffer.from(await crypto.subtle.digest("SHA-256", fs.readFileSync(script))).toString("base64");
  const m = { ...doc, entrySha256, pubkey: pub };
  delete m.signature;
  out = { ...m, signature: await signB64(enc(stable(m))) };
} else if (kind === "registry") {
  const entries = Array.isArray(doc) ? doc : doc.entries;
  if (!Array.isArray(entries)) {
    console.error("registry file must be an entries[] array or { entries }");
    process.exit(2);
  }
  // the authority signs the registry format with the entries (packages/tools registrySigningBytes)
  const format = 1;
  out = { format, entries, authority: pub, sig: await signB64(enc(stable({ format, entries }))) };
} else {
  console.error("kind must be 'manifest' or 'registry'");
  process.exit(2);
}

fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
if (kind === "manifest") console.log(`entrySha256 ${out.entrySha256}`);
console.log(`signed ${kind} -> ${file}  (authority/pubkey base64url: ${pub})`);
