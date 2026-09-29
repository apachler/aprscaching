#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Every export of the gateway (workers/gateway/src) has a user outside its own file: another module,
 * a runtime server, a test or a tool. An export nothing else names is module-private, so it is
 * declared without `export`; this keeps the gateway's public surface to what is actually shared.
 * The check is a word match over the tracked sources — cheap, with no dependency — and names each
 * offending declaration.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim().split("\n").filter(Boolean);

const sources = git("ls-files", "*.ts", "*.tsx", "*.mjs", "*.js").filter((f) => !f.includes("node_modules/"));
const text = new Map(sources.map((f) => [f, readFileSync(resolve(root, f), "utf8")]));
const gateway = sources.filter((f) => f.startsWith("workers/gateway/src/") && f.endsWith(".ts"));

/** Escape every regex metacharacter, so a name is matched literally. */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const DECL = /^export (?:declare )?(?:async )?(?:function\*?|const|let|class|interface|type|enum) ([A-Za-z0-9_$]+)/gm;
const unused = [];
for (const file of gateway) {
  for (const [, name] of text.get(file).matchAll(DECL)) {
    const word = new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`);
    const used = [...text].some(([other, body]) => other !== file && word.test(body));
    if (!used) unused.push(`${file}: ${name}`);
  }
}
if (unused.length) {
  console.error(`exports used only inside their own file (drop the \`export\`, or delete dead code):`);
  for (const u of unused) console.error(`  ${u}`);
  process.exit(1);
}
console.log(`dead-exports: ${gateway.length} gateway modules, every export has an outside user`);
