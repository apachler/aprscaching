#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The documentation stays true to the code and to `.claude/rules/docs-and-comments.md`. Four checks, each
 * naming every offending line:
 *
 *  1. Present tense — no milestone, review or ADR codes and no story framing ("previously", "for now", …)
 *     in the manual, the root documents and the READMEs. CHANGELOG.md is the one place history belongs,
 *     TODO.md keeps its P1–P3 priority scale, and dated review records under docs/reviews/ are exempt.
 *  2. Configuration — every environment key the code reads appears in docs/reference/configuration.md,
 *     and every key that page documents is read somewhere in the repository.
 *  3. Navigation — every mkdocs.yml nav entry exists, and every docs/ page is in the nav or `not_in_nav`.
 *  4. Links — every relative link in the root documents and READMEs (outside the mkdocs build, which
 *     checks its own) points at a file that exists.
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
const CONFIG = "docs/reference/configuration.md";
const source = (prefixes, exts) =>
  tracked.filter(
    (f) => prefixes.some((p) => f.startsWith(p)) && exts.some((e) => f.endsWith(e)) && !/\/test\//.test(f),
  );
const keysIn = (files, re) => {
  const out = new Set();
  for (const f of files) for (const m of read(f).matchAll(re)) out.add(m[1]);
  return out;
};
const envTs = read("workers/gateway/src/env.ts");
const listBody = envTs.slice(envTs.indexOf("ENV_STRING_KEYS = ["), envTs.indexOf("] as const"));
const used = new Set([...listBody.matchAll(/^\s*"([A-Z][A-Z0-9_]+)"/gm)].map((m) => m[1]));
for (const k of keysIn(source(["apps/ingest/src/"], [".ts"]), /\benv\.([A-Z][A-Z0-9_]+)\b/g)) used.add(k);
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
// Set by the servers for the shared app, or by the platform — not operator settings.
const INTERNAL = new Set(["FED_FETCH_GUARD", "HTTPS_LISTENER_PORT", "NODE_ENV", "HOME", "PATH", "CI"]);
const configText = read(CONFIG);
const documented = new Set([...configText.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)].map((m) => m[1]));
for (const k of [...used].sort())
  if (!INTERNAL.has(k) && !documented.has(k)) fail(CONFIG, 0, `${k} is read by the code but not documented`);
// The reverse: a documented key must be read somewhere (code, deploy scripts, compose files, Caddyfile).
const everything = tracked
  .filter((f) => !f.endsWith(".md") && !f.includes("node_modules/") && !/\.(png|webp|jpg|ico|woff2?)$/.test(f))
  .map(read)
  .join("\n");
// Tokens on the page that are protocol words or examples, not settings.
const NOT_KEYS = new Set(["APRSCG", "FOUND", "DNF", "NOTE", "HELP", "N0CALL", "GET", "POST", "SIGHUP", "TXT"]);
for (const k of [...documented].sort())
  if (!NOT_KEYS.has(k) && !new RegExp(`\\b${k}\\b`).test(everything))
    fail(CONFIG, 0, `${k} is documented but nothing reads it`);

// ---------------------------------------------------------------- 3. navigation
const mk = read("mkdocs.yml");
const navBlock = mk.slice(mk.indexOf("\nnav:"));
const navFiles = [...navBlock.matchAll(/(?:^\s*-\s+|:\s+)"?([\w./-]+\.md)"?\s*$/gm)].map((m) => m[1]);
for (const p of navFiles)
  if (!existsSync(join(root, "docs", p))) fail("mkdocs.yml", 0, `nav entry ${p} does not exist`);
const notInNav = [...(mk.match(/^not_in_nav: \|\n((?: {2}.*\n)+)/m)?.[1] ?? "").matchAll(/^ {2}(\S+)/gm)].map(
  (m) => new RegExp(`^${m[1].replace(/[.]/g, "\\.").replace(/\*/g, ".*")}$`),
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

if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  console.error(`\n${problems.length} documentation problem(s). The rules: .claude/rules/docs-and-comments.md`);
  process.exit(1);
}
console.log(
  `✓ docs: ${PROSE.length} files present-tense, ${used.size} config keys documented, nav complete, links resolve`,
);
