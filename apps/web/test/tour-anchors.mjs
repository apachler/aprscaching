#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// CI guard: the quick tour points at elements that exist.
//
// A coach mark's anchor is a `data-tour` hook in the JSX, and nothing in the type system ties the
// two ends together — renaming or dropping a hook leaves a step that silently degrades to an
// unanchored card, which looks fine in review and wrong to a first-time user. Launch week is the
// largest first-run audience the app ever gets at once, so the pairing is checked both ways: every
// step anchors to a hook that exists, and every hook in the app is claimed by a step.
//
// The steps are imported rather than parsed — Node reads the TypeScript module directly, so this
// checks the real exported data and not a regex's idea of it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const WHEN = new Set(["signed-out", "signed-in"]);
const MAX_BODY = 200; // a coach mark is one or two sentences (ui-ux.md §8)

// pathToFileURL: a bare absolute path is not an importable URL on Windows.
const { TOUR_STEPS } = await import(pathToFileURL(join(SRC, "ui", "tourSteps.ts")).href);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "node_modules") walk(p, out);
    } else if (/\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

// Where each hook is declared, so a failure names the file to fix.
const hooks = new Map();
for (const file of walk(SRC)) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/data-tour=(?:"([\w-]+)"|\{[^}]*?"([\w-]+)"[^}]*?\})/g)) {
    const name = m[1] ?? m[2];
    if (!hooks.has(name)) hooks.set(name, []);
    hooks.get(name).push(relative(ROOT, file));
  }
}

const problems = [];
const fail = (msg) => problems.push(msg);

if (!Array.isArray(TOUR_STEPS) || !TOUR_STEPS.length) fail("TOUR_STEPS is empty — the tour would render nothing");

const claimed = new Set();
TOUR_STEPS.forEach((step, i) => {
  const at = `step ${i + 1} (${JSON.stringify(step.title ?? "")})`;
  if (!step.title?.trim()) fail(`${at} has no title`);
  if (!step.body?.trim()) fail(`${at} has no body`);
  else if (step.body.length > MAX_BODY)
    fail(`${at} body is ${step.body.length} chars — keep a coach mark under ${MAX_BODY}`);
  if (step.when !== undefined && !WHEN.has(step.when))
    fail(`${at} has when="${step.when}" — expected ${[...WHEN].join(" or ")}`);
  if (step.anchor === undefined) return;

  const m = /^\[data-tour="([\w-]+)"\]$/.exec(step.anchor);
  if (!m) {
    fail(`${at} anchors on ${JSON.stringify(step.anchor)} — anchors must be a [data-tour="…"] hook, not a style class`);
    return;
  }
  claimed.add(m[1]);
  if (!hooks.has(m[1])) fail(`${at} anchors on data-tour="${m[1]}", which no .tsx in apps/web/src renders`);
});

for (const [name, files] of hooks)
  if (!claimed.has(name)) fail(`data-tour="${name}" is rendered by ${files.join(", ")} but no tour step points at it`);

// Both audiences see the tour — App opens it for a signed-in cacher and for a visitor exploring
// read-only, so a `when` filter that empties either one is a defect.
for (const signedIn of [true, false]) {
  const shown = TOUR_STEPS.filter((s) => !s.when || s.when === (signedIn ? "signed-in" : "signed-out"));
  if (!shown.length) fail(`no steps survive the when-filter for a ${signedIn ? "signed-in" : "signed-out"} session`);
}

if (!TOUR_STEPS.some((s) => s.anchor))
  fail("no step is anchored — the coach marks would all fall back to a centred card");

if (problems.length) {
  console.error(`tour-anchors guard: ${problems.length} problem${problems.length === 1 ? "" : "s"} in the quick tour:`);
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log(`tour-anchors guard: ${TOUR_STEPS.length} steps, ${claimed.size} anchors — every hook resolves.`);
