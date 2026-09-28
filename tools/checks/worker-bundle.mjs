#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Cloudflare Worker bundle carries no RF socket code. Workers cannot receive raw UDP, and RF ingest
 * runs only on the operator's own equipment, so the ingest listeners and senders (apps/ingest) must never
 * be reachable from the gateway's entry point. This builds the real Worker bundle with wrangler's dry run
 * (offline, nothing deployed) and fails if socket code appears in it.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const out = mkdtempSync(join(tmpdir(), "worker-bundle-"));
const r = spawnSync(
  "pnpm",
  ["--filter", "@aprscaching/gateway", "exec", "wrangler", "deploy", "--dry-run", "--outdir", out],
  {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  },
);
if (r.status !== 0) {
  console.error(r.stdout, r.stderr);
  console.error("✗ wrangler dry-run failed");
  process.exit(1);
}

const FORBIDDEN = [
  ["node:dgram", /["']node:dgram["']|["']dgram["']/],
  ["createSocket(", /\bcreateSocket\(/],
  ["MeshcomListener", /\bMeshcomListener\b/],
  ["MeshcomSender", /\bMeshcomSender\b/],
];
let failed = false;
for (const f of readdirSync(out).filter((f) => f.endsWith(".js"))) {
  const code = readFileSync(join(out, f), "utf8");
  for (const [label, re] of FORBIDDEN) {
    if (re.test(code)) {
      console.error(`✗ ${f} contains ${label}`);
      failed = true;
    }
  }
}
rmSync(out, { recursive: true, force: true });
if (!failed) console.log("✓ worker bundle carries no RF socket code");
process.exit(failed ? 1 : 0);
