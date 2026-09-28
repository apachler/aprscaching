#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * MeshCom core conformance across the three runtimes the platform targets.
 *
 * The pure core (packages/aprs/src/meshcom) is bundled once with esbuild into one platform-neutral ES
 * module, and that same file runs the golden fixtures on Node, on Bun and on workerd (via the Miniflare
 * that ships with wrangler). Each runtime must report zero failures and produce byte-identical outputs.
 *
 *   node tools/conformance/meshcom.mjs              # Bun is skipped (with a notice) when not installed
 *   CONFORMANCE_REQUIRE_BUN=1 node tools/conformance/meshcom.mjs
 */
import { build } from "esbuild";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { loadMeshcomFixtures } = await import(
  pathToFileURL(join(root, "packages/aprs/test/fixtures/meshcom/load.mjs")).href
);
const fixtures = loadMeshcomFixtures();

const work = mkdtempSync(join(tmpdir(), "meshcom-conformance-"));
const bundle = join(work, "meshcom-conformance.mjs");
await build({
  entryPoints: [join(root, "packages/aprs/test/conformance/meshcom.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  outfile: bundle,
  logLevel: "error",
});
const code = readFileSync(bundle, "utf8");
const fixturesFile = join(work, "fixtures.json");
writeFileSync(fixturesFile, JSON.stringify(fixtures));

const results = {};

// Node
{
  const { runMeshcomConformance } = await import(pathToFileURL(bundle).href);
  results.node = runMeshcomConformance(fixtures);
}

// Bun
{
  const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (bun.status === 0) {
    const script = `import { runMeshcomConformance } from ${JSON.stringify(bundle)};
      const f = JSON.parse(await Bun.file(${JSON.stringify(fixturesFile)}).text());
      process.stdout.write(JSON.stringify(runMeshcomConformance(f)));`;
    const r = spawnSync("bun", ["-e", script], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) {
      console.error(r.stderr);
      process.exit(1);
    }
    results.bun = JSON.parse(r.stdout);
  } else if (process.env.CONFORMANCE_REQUIRE_BUN) {
    console.error("✗ bun is required (CONFORMANCE_REQUIRE_BUN) but not installed");
    process.exit(1);
  } else {
    console.log("· bun not installed — Bun leg skipped");
  }
}

// Workers (workerd through the Miniflare that wrangler depends on — no extra dependency)
{
  const fromGateway = createRequire(join(root, "workers/gateway/package.json"));
  const fromWrangler = createRequire(fromGateway.resolve("wrangler/package.json"));
  const { Miniflare, convertV4MiniflareOptions } = fromWrangler("miniflare");
  const worker = `${code}
export default {
  async fetch(req) {
    return Response.json(runMeshcomConformance(await req.json()));
  },
};`;
  // One worker from a module script. Miniflare 5 takes its own options shape and ships a converter from
  // the long-standing v4 shape; Miniflare 4 takes the v4 shape directly.
  const v4 = { modules: true, script: worker, compatibilityDate: "2026-09-01" };
  const mf = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(v4) : v4);
  try {
    const res = await mf.dispatchFetch("http://conformance/", { method: "POST", body: JSON.stringify(fixtures) });
    results.workers = await res.json();
  } finally {
    await mf.dispose();
  }
}

rmSync(work, { recursive: true, force: true });

let failed = false;
const reference = JSON.stringify(results.node.outputs);
for (const [runtime, r] of Object.entries(results)) {
  if (r.failures.length) {
    failed = true;
    console.error(`✗ ${runtime}: ${r.failures.length} failure(s)`);
    for (const f of r.failures) console.error(`    ${f}`);
  } else if (JSON.stringify(r.outputs) !== reference) {
    failed = true;
    console.error(`✗ ${runtime}: outputs differ from Node`);
  } else {
    console.log(`✓ ${runtime}: ${fixtures.length} fixtures + encoder/dedup corpus`);
  }
}
process.exit(failed ? 1 : 0);
