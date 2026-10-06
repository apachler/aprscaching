// SPDX-License-Identifier: MIT
// Signs a manifest with tools/toolkey/sign.mjs, the script an author runs, so the test checks the app's
// verification against the real signer rather than against its own helper.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

/** Sign `manifest`, with `script` as its entry script beside it (given to the signer, so any `entry` works). */
export async function signWithToolkey(manifest, script = "register({});") {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", kp.privateKey)).toString("base64");
  const pub = Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("base64url");
  const dir = mkdtempSync(path.join(tmpdir(), "toolsig-"));
  const file = path.join(dir, "tool.json");
  const entry = path.join(dir, "tool.js");
  writeFileSync(file, JSON.stringify(manifest));
  writeFileSync(entry, script);
  execFileSync(process.execPath, [path.join(ROOT, "tools/toolkey/sign.mjs"), "manifest", file, entry], {
    env: { ...process.env, TOOL_PRIVATE_KEY: Buffer.from(JSON.stringify({ pkcs8, pub })).toString("base64") },
  });
  return JSON.parse(readFileSync(file, "utf8"));
}
