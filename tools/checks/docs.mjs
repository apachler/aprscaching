#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The documentation stays true to the code and to `.claude/rules/docs-and-comments.md`. Five checks, each
 * naming every offending line:
 *
 *  1. Present tense — no milestone, review or ADR codes and no story framing ("previously", "for now", …)
 *     in the manual, the root documents and the READMEs. CHANGELOG.md is the one place history belongs,
 *     TODO.md keeps its P1–P3 priority scale, and dated review records under docs/reviews/ are exempt.
 *  2. Configuration — every environment key the code reads is in the configuration schema, and every key
 *     the schema lists is read somewhere in the repository.
 *  3. Navigation — every mkdocs.yml nav entry exists, and every docs/ page is in the nav or `not_in_nav`.
 *  4. Links — every relative link in the root documents and READMEs (outside the mkdocs build, which
 *     checks its own) points at a file that exists.
 *  5. Diagrams — a fenced block in the manual, the READMEs or the rules draws no picture in box-drawing
 *     characters: a diagram is a ```mermaid block, which the manual and the in-app reader both draw. Real
 *     terminal output that uses them is marked by an `<!-- ascii-ok: <what it is> -->` line right above it.
 *
 * Pure word and path matching over the tracked files, with no dependency, so it runs before install.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
const read = (f) => readFileSync(join(root, f), "utf8");
const problems = [];
const fail = (f, line, msg) => problems.push(`${f}${line ? `:${line}` : ""}: ${msg}`);

// ---------------------------------------------------------------- 1. present tense
const PROSE = tracked.filter(
  (f) =>
    f.endsWith(".md") &&
    !f.includes("node_modules/") &&
    !["CHANGELOG.md", "TODO.md", ".claude/rules/docs-and-comments.md"].includes(f) &&
    !f.startsWith("docs/reviews/") &&
    (f.startsWith("docs/") ||
      !f.includes("/") ||
      /^(deploy|tools|servers|apps|packages|workers)\/.*README\.md$/.test(f)),
);
const CODES = [
  [/\b(?:M[0-9]|H[1-6]|W[1-4]|T3[a-e])\b(?!-)/, "milestone or track code"],
  [/\bF-[1-8]\b/, "feature-track code"],
  [/\b(?:Stage [0-9][A-Z]?|Phase [A-Z0-9]|Slice [A-Z])\b/, "phase/stage/slice label"],
  [/\bSR-[A-Z]+(?:-[0-9]+)?\b/, "review ID"],
  [/\bADR-[0-9]+[a-z]?\b/, "ADR label"],
];
const STORY = [
  /\bpreviously\b/i,
  /\boriginally\b/i,
  /\bfor now\b/i,
  /\bnow we\b/i,
  /\breborn\b/i,
  /\bgreenfield\b/i,
  /\bsquashed baseline\b/i,
  /\bdeferred while\b/i,
  /\bgrew unbounded\b/i,
  /\bwas broken\b/i,
  // habitual "used to", not the passive "is used to sign"
  /(?<!\b(?:is|are|was|were|be|been|being|get|gets|got|it's)\s)\bused to\b/i,
];
for (const f of PROSE) {
  let fence = false;
  read(f)
    .split("\n")
    .forEach((text, i) => {
      if (/^\s*```/.test(text)) fence = !fence;
      if (fence) return;
      const prose = text
        .replace(/`[^`]*`/g, "")
        .replace(/\]\([^)]*\)/g, "]")
        .replace(/https?:\/\/\S+/g, "");
      for (const [re, what] of CODES) if (re.test(prose)) fail(f, i + 1, `${what}: ${prose.match(re)[0]}`);
      for (const re of STORY) if (re.test(prose)) fail(f, i + 1, `story framing: "${prose.match(re)[0]}"`);
    });
}

// ---------------------------------------------------------------- 2. configuration keys
// The schema (packages/shared/src/config.ts) is the list of settings; its generated export is read here so
// this check needs no install. tools/config/generate.mjs --check keeps that export, the key tables of the
// configuration page and the .env.example files in step with the schema.
const SCHEMA = "deploy/lib/config-keys.json";
const schemaKeys = new Set(JSON.parse(read(SCHEMA)).keys.map((k) => k.name));
const source = (prefixes, exts) =>
  tracked.filter(
    (f) => prefixes.some((p) => f.startsWith(p)) && exts.some((e) => f.endsWith(e)) && !/\/test\//.test(f),
  );
const keysIn = (files, re) => {
  const out = new Set();
  for (const f of files) for (const m of read(f).matchAll(re)) out.add(m[1]);
  return out;
};
const used = new Set();
for (const k of keysIn(source(["workers/gateway/src/", "apps/ingest/src/"], [".ts"]), /\benv\.([A-Z][A-Z0-9_]+)\b/g))
  used.add(k);
// keys read through the ingest's typed helpers, e.g. numEnv("MESHCOM_RATE", 20)
for (const k of keysIn(
  source(["apps/ingest/src/", "servers/"], [".ts"]),
  /\b(?:numEnv|portEnv)\(\s*"([A-Z][A-Z0-9_]+)"/g,
))
  used.add(k);
for (const k of keysIn(
  source(["apps/ingest/src/", "servers/", "tools/licence/", "workers/gateway/src/"], [".ts", ".mjs"]),
  /process\.env(?:\.|\[")([A-Z][A-Z0-9_]+)/g,
))
  used.add(k);
for (const k of keysIn(source(["apps/web/src/"], [".ts", ".tsx"]), /import\.meta\.env\.(VITE_[A-Z0-9_]+)/g))
  used.add(k);
// what the compose files and the Caddyfile interpolate
for (const k of keysIn(
  tracked.filter((f) => /^deploy\/[^/]*\.yml$/.test(f) || f === "deploy/Caddyfile"),
  /\$\{([A-Z][A-Z0-9_]+)/g,
))
  used.add(k);
// Bindings, values the servers set for the shared app, and the platform's own — not operator settings.
const INTERNAL = new Set([
  "DB",
  "TILES",
  "MEDIA",
  "ROOMS",
  "FED_FETCH_GUARD",
  "HTTPS_LISTENER_PORT",
  "NODE_ENV",
  "HOME",
  "PATH",
  "CI",
]);
for (const k of [...used].sort())
  if (!INTERNAL.has(k) && !schemaKeys.has(k)) fail(SCHEMA, 0, `${k} is read by the code but not in the schema`);
// The reverse: a schema key must be read somewhere (code, deploy scripts, compose files, Caddyfile) — the
// schema, its generated outputs and the docs do not count.
const GENERATED = new Set([
  "packages/shared/src/configkeys.ts",
  "packages/shared/src/configdocs.ts",
  "tools/config/envfiles.mjs",
  ".env.example",
  "deploy/.env.example",
  "deploy/lib/config-keys.tsv",
  SCHEMA,
]);
const everything = tracked
  .filter(
    (f) =>
      !f.endsWith(".md") &&
      !GENERATED.has(f) &&
      !f.includes("node_modules/") &&
      !/\.(png|webp|jpg|ico|woff2?)$/.test(f),
  )
  .map(read)
  .join("\n");
for (const k of [...schemaKeys].sort())
  if (!new RegExp(`\\b${k}\\b`).test(everything)) fail(SCHEMA, 0, `${k} is in the schema but nothing reads it`);

// ---------------------------------------------------------------- 3. navigation
const mk = read("mkdocs.yml");
const navBlock = mk.slice(mk.indexOf("\nnav:"));
const navFiles = [...navBlock.matchAll(/(?:^\s*-\s+|:\s+)"?([\w./-]+\.md)"?\s*$/gm)].map((m) => m[1]);
for (const p of navFiles)
  if (!existsSync(join(root, "docs", p))) fail("mkdocs.yml", 0, `nav entry ${p} does not exist`);
const notInNav = [...(mk.match(/^not_in_nav: \|\n((?: {2}.*\n)+)/m)?.[1] ?? "").matchAll(/^ {2}(\S+)/gm)].map(
  // a gitignore-style glob: escape every regex metacharacter, then let `*` match any run of characters
  (m) => new RegExp(`^${m[1].replace(/[\\^$.|?+()[\]{}]/g, "\\$&").replace(/\*/g, ".*")}$`),
);
for (const f of tracked.filter((f) => f.startsWith("docs/") && f.endsWith(".md"))) {
  const page = f.slice("docs/".length);
  if (!navFiles.includes(page) && !notInNav.some((re) => re.test(page)))
    fail(f, 0, "page is neither in the mkdocs.yml nav nor in not_in_nav");
}

// ---------------------------------------------------------------- 4. links outside the manual
for (const f of PROSE.filter((f) => !f.startsWith("docs/"))) {
  read(f)
    .split("\n")
    .forEach((text, i) => {
      for (const m of text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
        const target = m[1];
        if (/^[a-z]+:/.test(target)) continue;
        if (!existsSync(join(root, dirname(f), target))) fail(f, i + 1, `broken link: ${target}`);
      }
    });
}

// ---------------------------------------------------------------- 5. diagrams are Mermaid
const DIAGRAM_DOCS = tracked.filter(
  (f) =>
    f.endsWith(".md") &&
    !f.startsWith("docs/reviews/") &&
    (f.startsWith("docs/") || f.startsWith(".claude/rules/") || /(^|\/)README\.md$/.test(f)),
);
for (const f of DIAGRAM_DOCS) {
  const lines = read(f).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*```(\w*)/.exec(lines[i]);
    if (!open) continue;
    const start = i;
    let drawn = 0;
    while (++i < lines.length && !/^\s*```\s*$/.test(lines[i])) if (/[\u2500-\u257F]/.test(lines[i])) drawn++;
    if (drawn && open[1] !== "mermaid" && !/<!--\s*ascii-ok:\s*\S/.test(lines[start - 1] ?? ""))
      fail(
        f,
        start + 1,
        "a diagram in box-drawing characters: draw it as a ```mermaid block (or mark real output <!-- ascii-ok: … -->)",
      );
  }
}

if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  console.error(`\n${problems.length} documentation problem(s). The rules: .claude/rules/docs-and-comments.md`);
  process.exit(1);
}
console.log(
  `✓ docs: ${PROSE.length} files present-tense, ${schemaKeys.size} config keys in the schema, nav complete, links resolve, diagrams are Mermaid`,
);
