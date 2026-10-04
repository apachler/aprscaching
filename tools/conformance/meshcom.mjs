#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * MeshCom core conformance across the runtimes the platform targets.
 *
 * The pure core (packages/aprs/src/meshcom) is bundled once with esbuild into one platform-neutral ES
 * module, and that same file runs the golden fixtures on Node and on Bun. Each runtime must report zero
 * failures and produce byte-identical outputs.
 *
 *   node tools/conformance/meshcom.mjs              # Bun is skipped (with a notice) when not installed
 *   CONFORMANCE_REQUIRE_BUN=1 node tools/conformance/meshcom.mjs
 */
import { build } from "esbuild";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
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
