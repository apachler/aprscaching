#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// CI guard (Cogmind): keep colour emoji out of rendered UI so the ASCII Cogmind theme
// stays emoji-free. Emoji are legal ONLY where they get swapped for a CP437/ASCII glyph at render:
//   • inside an <Ico e="…" c="…" /> element (Modern emoji → Cogmind ASCII),
//   • in a data glyph declaration (a `glyph:` / `cog:` / `emoji:` field),
//   • in the APRS category glyph map (aprsGlyph.ts).
// A raw emoji anywhere else (JSX text, a rendered string) is a regression: it would show through in
// Cogmind. This scan fails the build on such leaks. Comments are ignored.
//
// Detection is deliberately narrow (near-zero false positives): the colour-emoji SMP block plus a
// short blocklist of the BMP pictographs we've already replaced. Monochrome CP437/dingbat symbols we
// intentionally keep (✓ ✕ ★ ♥ ♡ ⚠ ● ◆ ◊ ▲ ○ ♪ ♣ ♠ ■ ☼ ☾ ⚑ ➤ ⌕ arrows, box-drawing …) are NOT flagged.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Scan `src` AND `public` — the service worker (public/sw.js, whose notification title/body
// reaches users) and public tool scripts render to users, so a raw emoji there must be flagged.
const ROOTS = [join(ROOT, "src"), join(ROOT, "public")];

/** True if `cp` is a colour emoji we must not render raw. */
function isEmoji(cp) {
  if (cp >= 0x1f000 && cp <= 0x1faff) return true; // SMP emoji/pictographs
  return cp === 0x2708 || cp === 0x26f5 || cp === 0x2614 || cp === 0x23f3 || cp === 0x2b50; // ✈ ⛵ ☔ ⏳ ⭐
}

/** A line may legitimately carry an emoji if it declares/wraps one for themed rendering. */
function lineAllowed(line, file) {
  const t = line.trim();
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return true; // comment
  if (line.includes("<Ico ")) return true; // <Ico e c/> wrapper
  if (/\b(glyph|cog|emoji)\s*:/.test(line)) return true; // data glyph field
  if (basename(file) === "aprsGlyph.ts") return true; // APRS category map
  return false;
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (name !== "node_modules") walk(p, out);
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) out.push(p);
  }
}

const files = [];
for (const root of ROOTS) walk(root, files);
const violations = [];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (lineAllowed(line, file)) return;
    for (const ch of line) {
      const cp = ch.codePointAt(0);
      if (isEmoji(cp)) violations.push(`${file}:${i + 1}  ${ch}  ${line.trim()}`);
    }
  });
}

if (violations.length) {
  console.error(`no-emoji guard: ${violations.length} raw emoji in rendered UI (wrap in <Ico e c/> or a glyph map):`);
  for (const v of violations) console.error("  " + v);
  process.exit(1);
}
console.log(`no-emoji guard: ${files.length} files clean — Cogmind stays ASCII.`);
