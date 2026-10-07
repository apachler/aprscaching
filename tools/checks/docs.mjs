#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The documentation stays true to the code and to `.claude/rules/docs-and-comments.md`. Eight checks, each
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
 *     characters: a diagram is a ```mermaid block, which the manual draws. Real
 *     terminal output that uses them is marked by an `<!-- ascii-ok: <what it is> -->` line right above it.
 *  6. Stale references — pages move without redirects, so every reference to a manual page or heading in any
 *     tracked file (paths, published URLs, the app's manual links, the doctor's hints) must still resolve.
 *  7. Lists — a list item MkDocs would read as paragraph text, for want of a blank line before it.
 *  8. Wordmark — the product is APRScaching in prose; the lowercase form only as a path, domain or command.
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
  "TOOL_FETCH_GUARD",
  "HTTPS_LISTENER_PORT",
  "DESKTOP_APP",
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

// ---------------------------------------------------------------- 6. no stale references to the manual
// Manual pages move without redirects, so every reference to one, in any tracked file, must name a page (and a
// heading) that exists: `docs/…md` paths in code, scripts and comments, the published URL, the web app's
// `manualUrl("page", "anchor")` calls and `<ManualLink page="…" anchor="…">` links, the doctor's `$DOCS_URL/…`
// hints and the configuration schema's links (relative to
// docs/reference/, where they are rendered). Links inside the manual are checked by `mkdocs build --strict`.
/** The published manual: a page is `<site>/<path>/`, the home page the bare site. */
const SITE_URL = /apachler\.github\.io\/aprscaching\/([\w/-]*?)\/?(?:#([\w-]+))?(?=[)\s"'>`]|$)/g;
/** Python-Markdown's toc slug: what MkDocs gives a heading as its anchor. */
const slug = (h) =>
  h
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*]/g, "")
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "-");
const anchorCache = new Map();
function anchorsOf(page) {
  if (!anchorCache.has(page)) {
    const set = new Set();
    let fence = false;
    for (const l of read(`docs/${page}`).split("\n")) {
      if (/^\s*(```|~~~)/.test(l)) fence = !fence;
      const h = !fence && /^#{1,6} (.*?)\s*$/.exec(l);
      if (!h) continue;
      const id = /\{#([\w-]+)\}\s*$/.exec(h[1]);
      let a = id ? id[1] : slug(h[1]);
      for (let n = 1; !id && set.has(a); n++) a = `${slug(h[1])}_${n}`;
      set.add(a);
    }
    for (const m of read(`docs/${page}`).matchAll(/\{\s*#([\w-]+)\s*\}|<(?:a|span) id="([\w-]+)"/g))
      set.add(m[1] ?? m[2]);
    anchorCache.set(page, set);
  }
  return anchorCache.get(page);
}
function checkRef(f, line, page, anchor, as) {
  if (!existsSync(join(root, "docs", page))) return fail(f, line, `stale manual reference: ${as} (no docs/${page})`);
  if (anchor && !anchorsOf(page).has(anchor)) fail(f, line, `stale manual reference: ${as} (no heading #${anchor})`);
}
const TEXT = tracked.filter(
  (f) =>
    !f.startsWith("docs/") &&
    f !== "CHANGELOG.md" &&
    f !== "pnpm-lock.yaml" &&
    f !== "tools/checks/docs.mjs" &&
    !f.includes("node_modules/") &&
    !/\.(png|webp|jpg|avif|ico|svg|woff2?|pmtiles|zip)$/.test(f),
);
for (const f of TEXT) {
  read(f)
    .split("\n")
    .forEach((text, i) => {
      for (const m of text.matchAll(/(?<![\w-])docs\/([\w./-]+\.md)(?:#([\w-]+))?/g))
        checkRef(f, i + 1, m[1], m[2], m[0]);
      for (const m of text.matchAll(SITE_URL)) {
        const p = m[1];
        const page = !p ? "index.md" : existsSync(join(root, "docs", `${p}.md`)) ? `${p}.md` : `${p}/index.md`;
        checkRef(f, i + 1, page, m[2], m[0]);
      }
      for (const m of text.matchAll(/manualUrl\(\s*"([\w/-]+)"(?:\s*,\s*"([\w-]+)")?/g))
        checkRef(f, i + 1, `${m[1]}.md`, m[2], m[0]);
      for (const m of text.matchAll(/<ManualLink\b[^>]*?\bpage="([\w/-]+)"(?:[^>]*?\banchor="([\w-]+)")?/g))
        checkRef(f, i + 1, `${m[1]}.md`, m[2], m[0]);
      for (const m of text.matchAll(/\$DOCS_URL\/([\w./-]+\.md)(?:#([\w-]+))?/g)) checkRef(f, i + 1, m[1], m[2], m[0]);
      if (f === "packages/shared/src/configdocs.ts")
        for (const m of text.matchAll(/\]\(([\w./-]+\.md)(?:#([\w-]+))?\)/g))
          checkRef(f, i + 1, join("reference", m[1]).replace(/\\/g, "/"), m[2], m[0]);
    });
}

// Every doctor warning and failure links `docs/run/troubleshooting.md#<anchor>` (deploy/lib/doctor.sh doc_see), so
// every check id the doctor and the shapes report needs its entry there. A check named after a setting, a node or
// a peer shares the entry of its kind, as doc_see maps it.
{
  const page = "run/troubleshooting.md";
  const see = (id) =>
    /^config\.value\./.test(id)
      ? "configvaluekey"
      : /^setup\.(checklist|budget|update)$/.test(id)
        ? id.replace(/\./g, "")
        : /^setup\./.test(id)
          ? "setupitem"
          : /^ingest\.meshcom_fw\./.test(id)
            ? "ingestmeshcom_fwcall"
            : /^ingest\.meshcom\./.test(id)
              ? "ingestmeshcomcall"
              : /^ingest\.soundcard_(audio|ptt|tx)\./.test(id)
                ? `${id.replace(/\.[^.]*$/, "").replace(/\./g, "")}port`
                : /^federation\.peer\./.test(id)
                  ? "federationpeerhost"
                  : /^identity\./.test(id)
                    ? "identityline"
                    : id.replace(/\./g, "");
  for (const f of tracked.filter((f) => /^deploy\/(lib\/doctor\.sh|lib\/shapes\/[\w-]+\.sh)$/.test(f)))
    read(f)
      .split("\n")
      .forEach((text, i) => {
        const m = /\b(?:warnc|failc)\s+"?([a-z0-9_.-]+(?:\$\{?[\w,]+\}?)?[a-z0-9_.-]*)/.exec(text);
        if (!m) return;
        // a variable part stands for a name: ingest.${name,,} is one of the named links, checked by its kind
        const id = m[1].includes("$") ? m[1].replace(/\$\{?[\w,]+\}?/, "x") : m[1];
        // a service check loops over the services its shape runs: each needs its entry
        const services = {
          "deploy/lib/shapes/selfhost.sh": ["gateway", "ingest", "caddy", "cloudflared"],
          "deploy/lib/shapes/baremetal.sh": ["aprscaching-gateway", "aprscaching-ingest"],
        }[f];
        if (/^service\.x$/.test(id) && services) {
          for (const n of services) checkRef(f, i + 1, page, `service${n}`, `service.${n}`);
          return;
        }
        if (/^ingest\.x$/.test(id)) {
          for (const n of ["kiss_tnc", "agwpe", "hostmode", "meshtastic"])
            checkRef(f, i + 1, page, `ingest${n}`, `ingest.${n}`);
          return;
        }
        checkRef(f, i + 1, page, see(id), `doctor check ${m[1]}`);
      });
}

// ---------------------------------------------------------------- 7. lists the manual's Markdown can parse
// MkDocs's Markdown (Python-Markdown) needs a blank line before a list item in two places CommonMark does not: a
// list that starts right after a paragraph, and the next item after an item that holds a blank line (a second
// paragraph, an indented note). Without it the markers are read as text: "… listen for it. 2. Send that …".
// A list item is fine when the lines above it, back to the last blank line, belong to an item.
{
  const MARK = /^\s*(\d+\.|[-*+])\s/;
  const FENCE = /^\s*(```|~~~)/;
  for (const f of tracked.filter((f) => f.startsWith("docs/") && f.endsWith(".md") && !f.startsWith("docs/reviews/"))) {
    // a block quote's lines are read without their "> " prefix
    const lines = read(f)
      .split("\n")
      .map((l) => l.replace(/^>\s?/, ""));
    const fenceStart = new Map();
    let open = -1;
    lines.forEach((l, i) => {
      if (!FENCE.test(l)) return;
      if (open < 0) open = i;
      else {
        fenceStart.set(i, open);
        open = -1;
      }
    });
    let inFence = false;
    lines.forEach((l, i) => {
      if (FENCE.test(l)) {
        inFence = !inFence;
        return;
      }
      if (inFence || !MARK.test(l) || i === 0 || !lines[i - 1].trim()) return;
      for (let j = i - 1; j >= 0;) {
        if (fenceStart.has(j)) {
          j = fenceStart.get(j) - 1;
          continue;
        }
        const p = lines[j];
        if (!p.trim() || /^\s*(#|\||<(?!!--))/.test(p)) {
          fail(f, i + 1, "a list item needs a blank line before it here, or it renders as text");
          return;
        }
        if (MARK.test(p) || /^\s*(!!!|\?\?\?)/.test(p)) return;
        j--;
      }
    });
  }
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

// ---------------------------------------------------------------- 8. the wordmark
// The product is written APRScaching wherever a reader meets it as a name. The lowercase form stays only where it
// is a literal: a path, domain, package, command, user or key, which sits in a code span, a link target or a URL
// in Markdown, or is joined to a path or domain by `/`, `.`, `-`, `_` or `@`.
const WORDMARK_DOCS = tracked.filter(
  (f) =>
    f.endsWith(".md") &&
    !f.includes("node_modules/") &&
    f !== "CHANGELOG.md" &&
    !f.startsWith("docs/reviews/") &&
    (PROSE.includes(f) || f === "TODO.md" || f.startsWith(".claude/")),
);
const LOWER = /(?<![\w./@$~%\\-])aprscaching(?![\w/-])(?!\.[A-Za-z])/;
const VARIANT = /\b(?:Aprscaching|APRSCaching|APRS[ -]caching|aprs[ -]caching)\b/;
for (const f of WORDMARK_DOCS) {
  let fence = false;
  let span = false; // inside a code span that a line break continues
  read(f)
    .split("\n")
    .forEach((text, i) => {
      if (/^\s*```/.test(text)) fence = !fence;
      if (fence) return;
      if (!text.trim()) span = false;
      let line = span ? text.replace(/^[^`]*`?/, "") : text;
      span = span && !text.includes("`");
      line = line.replace(/`[^`]*`/g, "");
      if (line.includes("`")) {
        line = line.slice(0, line.indexOf("`"));
        span = true;
      }
      const prose = line
        // each removed part becomes a space, so nothing joins up across it; the text is only read, never rendered
        .replace(/\]\([^)]*\)/g, "] ")
        .replace(/<[^>]*>/g, " ")
        .replace(/https?:\/\/\S+/g, " ");
      const m = prose.match(LOWER) ?? prose.match(VARIANT);
      if (m)
        fail(f, i + 1, `the product is written APRScaching, not "${m[0]}" (a path or command goes in a code span)`);
    });
}

if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  console.error(`\n${problems.length} documentation problem(s). The rules: .claude/rules/docs-and-comments.md`);
  process.exit(1);
}
console.log(
  `✓ docs: ${PROSE.length} files present-tense, ${schemaKeys.size} config keys in the schema, nav complete, links resolve, diagrams are Mermaid, no stale manual references, lists parse, the wordmark holds`,
);
