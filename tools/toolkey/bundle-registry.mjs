#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Bundle a tagged release of the project's tool registry (apachler/aprscaching-tools) into the web app, as the
// registry every instance serves at /tools/registry.json. The repository's layout is kept under the output
// folder: `registry.json` at its root and each tool at `tools/<name>/`, so the registry's relative entries
// (`tools/hello/tool.json`) resolve against /tools/registry.json to /tools/tools/hello/tool.json, the files the
// bundle holds. Nothing is rewritten: the signatures cover the files as published.
//
// Before anything is written, every file is checked the way the app checks it: the registry's signature against
// the pinned authority key, each listed manifest's signature against the author key its entry lists, and each
// script's bytes against the SHA-256 its signed manifest pins (`entrySha256`). An entry outside the repository
// is not bundled; the app then fetches it from its own address. After writing, the bundled registry is read back
// from disk and verified again. Any failure exits 1 and leaves the output folder as it was.
//
//   node tools/toolkey/bundle-registry.mjs <tag> [--repo owner/repo] [--out apps/web/public/tools]
//                                          [--authority <base64url key>] [--source <local checkout>]
//
// The authority defaults to the project key pinned in packages/shared/src/toolregistries.ts. `--source` reads a
// local checkout of the tag instead of raw.githubusercontent.com.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const tag = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
if (!tag) {
  console.error(
    "usage: node tools/toolkey/bundle-registry.mjs <tag> [--repo owner/repo] [--out dir] [--authority key] [--source dir]",
  );
  process.exit(2);
}
const repo = opt("repo", "apachler/aprscaching-tools");
const out = path.resolve(root, opt("out", "apps/web/public/tools"));
const source = opt("source");
const pinnedFromSource = () => {
  const ts = fs.readFileSync(path.join(root, "packages/shared/src/toolregistries.ts"), "utf8");
  const m = /authority:\s*"([A-Za-z0-9_-]{43})"/.exec(ts);
  if (!m) throw new Error("no authority key found in packages/shared/src/toolregistries.ts");
  return m[1];
};
const authority = opt("authority") ?? pinnedFromSource();
const base = source ? "https://bundle.invalid/" : `https://raw.githubusercontent.com/${repo}/${tag}/`;

// ---- the canonical bytes and Ed25519, as packages/tools/src/registry.ts ----
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
const enc = (s) => new TextEncoder().encode(s);
const bytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
async function ed25519Verify(pubB64url, sigB64, data) {
  try {
    const key = await crypto.subtle.importKey("raw", bytes(pubB64url), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, bytes(sigB64), data);
  } catch {
    return false;
  }
}
const sha256B64 = async (buf) => Buffer.from(await crypto.subtle.digest("SHA-256", buf)).toString("base64");

/** The bytes at an address inside the release: from the local checkout, or from GitHub. */
async function read(url) {
  const relPath = url.slice(base.length);
  if (source) return fs.readFileSync(path.join(source, relPath));
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
/** The path inside the release an address stands for, or null when it leaves the release. */
const inside = (url) =>
  url.startsWith(base) && !url.slice(base.length).split("/").includes("..") ? url.slice(base.length) : null;

const fail = (m) => {
  console.error(`FAIL  ${m}`);
  process.exit(1);
};

async function verifyRegistry(doc) {
  if (!doc || !Array.isArray(doc.entries) || typeof doc.sig !== "string")
    fail("registry.json is not a signed registry");
  if (doc.authority !== authority) fail(`registry.json is signed by ${doc.authority}, not the pinned ${authority}`);
  if (!(await ed25519Verify(authority, doc.sig, enc(stable(doc.entries)))))
    fail("registry.json: the signature does not verify");
}

const files = new Map(); // path inside the release → bytes
const regBytes = await read(`${base}registry.json`);
const reg = JSON.parse(regBytes.toString("utf8"));
await verifyRegistry(reg);
files.set("registry.json", regBytes);
console.log(`ok    registry.json: ${reg.entries.length} entries, signed by the pinned key`);

for (const e of reg.entries) {
  const manifestUrl = new URL(e.entry, `${base}registry.json`).href;
  const mPath = inside(manifestUrl);
  if (!mPath) {
    console.log(`info  ${e.name}: ${e.entry} is outside the release; the app fetches it from there`);
    continue;
  }
  const mBytes = await read(manifestUrl);
  const m = JSON.parse(mBytes.toString("utf8"));
  if (m.name !== e.name) fail(`${mPath}: names ${m.name}, the entry ${e.name}`);
  if (m.pubkey !== e.pubkey) fail(`${mPath}: signed by ${m.pubkey}, the entry lists ${e.pubkey}`);
  const rest = { ...m };
  delete rest.signature;
  if (typeof m.signature !== "string" || !(await ed25519Verify(m.pubkey, m.signature, enc(stable(rest)))))
    fail(`${mPath}: the manifest's signature does not verify`);
  if (typeof m.entrySha256 !== "string") fail(`${mPath}: pins no entrySha256; sign it with tools/toolkey/sign.mjs`);
  const scriptUrl = new URL(typeof m.entry === "string" ? m.entry : "tool.js", manifestUrl).href;
  const sPath = inside(scriptUrl);
  if (!sPath) fail(`${mPath}: its script ${scriptUrl} is outside the release`);
  const sBytes = await read(scriptUrl);
  if ((await sha256B64(sBytes)) !== m.entrySha256) fail(`${sPath}: its bytes do not match the manifest's entrySha256`);
  files.set(mPath, mBytes);
  files.set(sPath, sBytes);
  console.log(`ok    ${e.name}: ${mPath} and ${sPath}`);
}

// write into a fresh folder beside the output, then swap it in, so a failure leaves the bundle as it was
const staging = `${out}.bundling`;
fs.rmSync(staging, { recursive: true, force: true });
for (const [p, b] of files) {
  const dest = path.join(staging, p);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, b);
}
await verifyRegistry(JSON.parse(fs.readFileSync(path.join(staging, "registry.json"), "utf8")));
fs.rmSync(out, { recursive: true, force: true });
fs.renameSync(staging, out);
console.log(`bundled ${repo}@${tag} into ${path.relative(root, out) || out} (${files.size} files)`);
