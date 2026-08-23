#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// CI guard: the OCI Resource Manager stack in deploy/oci stays internally consistent.
//
// The stack ships as a zip release artifact that a "Deploy to Oracle Cloud" button hands straight to
// Resource Manager, so a mismatch inside it surfaces to an operator as a failed Plan on a fresh
// tenancy rather than as a test failure here. The four ways it can drift are all mechanical:
//
//   • a variable added to main.tf but never prompted for in schema.yaml (Plan asks for nothing and
//     fails on a missing required value), or the reverse — a schema entry for a variable that no
//     longer exists (Resource Manager rejects the stack outright),
//   • a placeholder used in cloud-init.yaml that main.tf's templatefile() call does not supply,
//   • an output rendered in the console that main.tf does not emit,
//   • the repo_ref default losing the line shape scripts/build-oci-stack.sh rewrites, which would
//     silently publish a release stack that tracks main instead of pinning its tag.
//
// Terraform's own `validate` covers syntax and provider schema; it cannot see any of the above,
// because schema.yaml and the build script are outside its world.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const problems = [];
const fail = (msg) => problems.push(msg);
const list = (xs) => [...xs].sort().join(", ") || "(none)";

const mainTf = read("deploy/oci/main.tf");
const cloudInit = read("deploy/oci/cloud-init.yaml");
const schemaSrc = read("deploy/oci/schema.yaml");
const buildSh = read("scripts/build-oci-stack.sh");

// ---- schema.yaml: the three name sets the guard compares against main.tf ----
// A deliberately small reader for the shape this file has (and that prettier keeps it in): top-level
// keys at column 0, mapping entries two spaces in, sequence members six spaces in under a group.
function readSchema(src) {
  const declared = new Set(); // variables: <name>:
  const grouped = []; // variableGroups[].variables[] — an array, so repeats are visible
  const outputs = new Set(); // outputs: <name>:
  let top = null;
  for (const raw of src.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line || line.trimStart().startsWith("#")) continue;
    const atCol0 = /^([A-Za-z_][\w-]*):/.exec(line);
    if (atCol0) {
      top = atCol0[1];
      continue;
    }
    const entry = /^ {2}([A-Za-z_][\w-]*):/.exec(line);
    if (entry) {
      if (top === "variables") declared.add(entry[1]);
      else if (top === "outputs") outputs.add(entry[1]);
      continue;
    }
    const member = /^ {6}- ([A-Za-z_][\w-]*)$/.exec(line);
    if (member && top === "variableGroups") grouped.push(member[1]);
  }
  return { declared, grouped, outputs };
}
const schema = readSchema(schemaSrc);

// ---- main.tf ----
const tfVariables = new Set([...mainTf.matchAll(/^variable "([^"]+)"/gm)].map((m) => m[1]));
const tfOutputs = new Set([...mainTf.matchAll(/^output "([^"]+)"/gm)].map((m) => m[1]));

if (!tfVariables.size) fail("main.tf declares no variables — the parse above is wrong, not the file");

// variables ↔ schema.variables
for (const v of tfVariables)
  if (!schema.declared.has(v)) fail(`schema.yaml is missing variable "${v}" declared in main.tf`);
for (const v of schema.declared)
  if (!tfVariables.has(v)) fail(`schema.yaml declares variable "${v}", which main.tf does not`);

// every variable is prompted exactly once — an ungrouped one is invisible in the console, and a
// duplicated one renders twice
const groupCount = new Map();
for (const v of schema.grouped) groupCount.set(v, (groupCount.get(v) ?? 0) + 1);
for (const v of tfVariables) {
  const n = groupCount.get(v) ?? 0;
  if (n === 0) fail(`variable "${v}" is in no variableGroup — Resource Manager would never prompt for it`);
  else if (n > 1) fail(`variable "${v}" appears in ${n} variableGroups — it must appear in exactly one`);
}
for (const v of schema.grouped)
  if (!tfVariables.has(v)) fail(`variableGroups reference "${v}", which main.tf does not declare`);

// outputs ↔ schema.outputs
for (const o of tfOutputs) if (!schema.outputs.has(o)) fail(`schema.yaml is missing output "${o}"`);
for (const o of schema.outputs)
  if (!tfOutputs.has(o)) fail(`schema.yaml declares output "${o}", which main.tf does not emit`);

// ---- cloud-init placeholders ↔ the templatefile() vars map ----
const tmplBlock = /templatefile\("\$\{path\.module\}\/cloud-init\.yaml",\s*\{([\s\S]*?)\}\)\)/.exec(mainTf);
if (!tmplBlock) fail("main.tf no longer calls templatefile() on cloud-init.yaml in the expected shape");
else {
  const supplied = new Set([...tmplBlock[1].matchAll(/^\s*([A-Z_][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]));
  const used = new Set([...cloudInit.matchAll(/\$\{([A-Za-z_][\w]*)\}/g)].map((m) => m[1]));
  for (const p of used)
    if (!supplied.has(p)) fail(`cloud-init.yaml uses \${${p}}, which templatefile() does not supply`);
  for (const p of supplied) if (!used.has(p)) fail(`templatefile() supplies ${p}, which cloud-init.yaml never uses`);
  if (!used.size) fail(`cloud-init.yaml has no placeholders — supplied: ${list(supplied)}`);
}

// ---- the release build's two couplings to these files ----
const stampTarget = /^ {2}default {5}= "main"$/m;
if (!stampTarget.test(mainTf))
  fail('main.tf has no `  default     = "main"` line — scripts/build-oci-stack.sh could not pin repo_ref to a tag');
if (!/default {5}= \\"\$REF\\"/.test(buildSh))
  fail("scripts/build-oci-stack.sh no longer stamps the repo_ref default — its sed and main.tf have drifted apart");

const filesLine = /^FILES=\(([^)]*)\)/m.exec(buildSh);
if (!filesLine) fail("scripts/build-oci-stack.sh no longer declares a FILES=( … ) list");
else {
  const packaged = new Set(filesLine[1].trim().split(/\s+/));
  // Resource Manager reads main.tf and schema.yaml from the zip ROOT; cloud-init is templated at
  // plan time, so all three have to travel with it.
  for (const required of ["main.tf", "cloud-init.yaml", "schema.yaml"])
    if (!packaged.has(required)) fail(`the stack zip would not contain ${required}`);
}

if (problems.length) {
  console.error(
    `oci-stack guard: ${problems.length} inconsistenc${problems.length === 1 ? "y" : "ies"} in deploy/oci:`,
  );
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log(
  `oci-stack guard: ${tfVariables.size} variables and ${tfOutputs.size} outputs match schema.yaml; the release zip pins its ref.`,
);
