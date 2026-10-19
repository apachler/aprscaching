#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// CI guard: a workflow job that holds a write token runs no code that could take it or poison what it builds.
//
// Such a job (one whose permissions, or the workflow's when the job sets none, grant any `write` scope):
//   • checks out with `persist-credentials: false`, so the GITHUB_TOKEN is not left in .git/config for the
//     install scripts and build tools that run after the checkout to read,
//   • restores no cache (actions/cache, a `cache:` input that is not false, a Buildx `cache-from: type=gha`, or
//     setup-bun and setup-go, which cache unless told not to), so it reads only its own lockfile and the
//     registry, never a store another run wrote.
// A job that needs both a write token and the build splits in two: the build with a read token uploads an
// artifact, and a job with the write token and no checkout attaches it.
//
// The workflows are read line by line in the shape this repository writes them (two-space indents, `jobs:` at
// the top level, steps as `- ` items); a file this reader cannot follow is a failure, not a pass.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIR = process.argv[2] ?? join(ROOT, ".github", "workflows");
const problems = [];
let writeJobs = 0;

const indent = (line) => line.length - line.trimStart().length;

/** The lines of the block under `lines[at]`: every following line indented deeper (blank lines included). */
function block(lines, at) {
  const base = indent(lines[at]);
  const out = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (lines[i].trim() && indent(lines[i]) <= base) break;
    out.push(lines[i]);
  }
  return out;
}

/** Whether a `permissions:` line (and its block) grants any write scope. */
function grantsWrite(lines, at) {
  const inline = lines[at].replace(/#.*/, "").split("permissions:")[1].trim();
  if (inline) return /write/.test(inline);
  return block(lines, at).some((l) => /^\s*[\w-]+:\s*write\b/.test(l));
}

/** Whether a step's text restores a cache: actions/cache, a `cache:` input other than false, a Buildx cache
 *  from the Actions cache, or a setup action that caches unless told not to (setup-bun, setup-go). */
function restoresCache(text) {
  if (/uses:\s*actions\/cache[@/]/.test(text)) return true;
  if (/\bcache-from:[^\n]*type=gha/.test(text)) return true;
  const cache = /(?:^|[\s{,])cache:\s*["']?([\w-]+)/.exec(text);
  if (cache && cache[1] !== "false") return true;
  if (/uses:\s*oven-sh\/setup-bun@/.test(text) && !/\bno-cache:\s*["']?true\b/.test(text)) return true;
  if (/uses:\s*actions\/setup-go@/.test(text) && !cache) return true;
  return false;
}

for (const name of readdirSync(DIR)
  .filter((f) => /\.ya?ml$/.test(f))
  .sort()) {
  const lines = readFileSync(join(DIR, name), "utf8").split("\n");
  const top = lines.findIndex((l) => /^permissions:/.test(l));
  const topWrite = top >= 0 && grantsWrite(lines, top);
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobsAt < 0) {
    problems.push(`${name}: no top-level jobs: block`);
    continue;
  }
  const jobs = [];
  for (let i = jobsAt + 1; i < lines.length; i++) {
    if (lines[i].trim() && indent(lines[i]) === 0) break;
    const m = /^ {2}([\w-]+):\s*$/.exec(lines[i]);
    if (m) jobs.push({ id: m[1], at: i });
  }
  if (!jobs.length) problems.push(`${name}: no jobs found under jobs:`);
  for (const { id, at } of jobs) {
    const body = [lines[at], ...block(lines, at)];
    const perm = body.findIndex((l) => /^ {4}permissions:/.test(l));
    const write = perm >= 0 ? grantsWrite(body, perm) : topWrite;
    if (!write) continue;
    writeJobs++;
    const where = `${name} job ${id}`;
    // a reusable workflow's jobs are checked in their own file
    if (body.some((l) => /^ {4}uses:/.test(l))) continue;
    const stepsAt = body.findIndex((l) => /^ {4}steps:\s*$/.test(l));
    if (stepsAt < 0) {
      problems.push(`${where}: holds a write token but has no steps: block this check can read`);
      continue;
    }
    const steps = [];
    for (const l of block(body, stepsAt)) {
      if (/^ {6}- /.test(l)) steps.push([l]);
      else if (steps.length) steps.at(-1).push(l);
    }
    for (const step of steps) {
      const text = step.map((l) => l.replace(/\s+#.*$/, "")).join("\n");
      if (/uses:\s*actions\/checkout@/.test(text) && !/persist-credentials:\s*false\b/.test(text))
        problems.push(`${where}: checks out without persist-credentials: false while it holds a write token`);
      if (restoresCache(text)) problems.push(`${where}: restores a cache while it holds a write token`);
    }
  }
}

if (!writeJobs) problems.push(`no job with a write token found in ${DIR}: the check saw nothing`);
if (problems.length) {
  for (const p of problems) console.error(`workflows: ${p}`);
  process.exit(1);
}
console.log(`workflows: ${writeJobs} jobs with a write token checked`);
