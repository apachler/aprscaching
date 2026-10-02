// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * vite-docs — bundle the repo's `docs/` markdown manual straight into the SPA at build time, so the
 * platform serves its own documentation with no MkDocs, no static-site step, and no extra container.
 * The markdown stays the single source of truth (MkDocs still builds the same files for the public
 * site); this plugin exposes them to the app as a `virtual:docs` module of `{ slug, title, section, order,
 * body }` records, in the order, sections and titles of `mkdocs.yml`'s nav. Rendering happens client-side (see
 * src/docs/markdown.ts).
 */
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

const VIRTUAL_ID = "virtual:docs";
const RESOLVED_ID = "\0" + VIRTUAL_ID;

export interface NavEntry {
  slug: string;
  title: string;
  /** the top-level nav section, or "" for a page at the top level */
  section: string;
}

export interface MkdocsNav {
  pages: NavEntry[];
  /** `not_in_nav` patterns: built, linkable, but kept out of the manual's contents */
  notInNav: RegExp[];
}

/**
 * The manual's contents from `mkdocs.yml`, so the in-app reader and the published manual list the same pages in
 * the same order under the same names. Only the `nav` and `not_in_nav` blocks are read: nav items are
 * `- Title: page.md` or `- Section:` with an indented list, and quoted titles keep their quotes stripped. (A full
 * YAML parse would choke on the `!!python/name` tags elsewhere in the file.)
 */
export function parseMkdocsNav(yml: string): MkdocsNav {
  const lines = yml.split("\n");
  const start = lines.findIndex((l) => /^nav:\s*$/.test(l));
  if (start < 0) throw new Error("mkdocs.yml has no nav");
  const pages: NavEntry[] = [];
  let section = "";
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\S/.test(l)) break; // the next top-level key ends the nav
    const m = /^(\s*)-\s+("?)(.+?)\2:\s*(\S*)\s*$/.exec(l);
    if (!m) continue;
    const depth = m[1]!.length;
    const title = m[3]!;
    const file = m[4]!;
    if (!file) {
      if (depth === 2) section = title;
      continue;
    }
    if (depth === 2) section = "";
    pages.push({ slug: file.replace(/\.md$/, ""), title, section });
  }
  const block = /^not_in_nav:\s*\|\n((?:[ \t]+.*\n?)+)/m.exec(yml)?.[1] ?? "";
  const notInNav = block
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"));
  return { pages, notInNav };
}

/** Recursively list `*.md` files under `dir`, returned as slash-joined paths relative to `dir`. */
function listMarkdown(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdown(full, base));
    else if (entry.isFile() && entry.name.endsWith(".md"))
      out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

export function docsPlugin(docsDir: string): Plugin {
  const mkdocsYml = path.join(docsDir, "..", "mkdocs.yml");
  const build = () => {
    const { pages: nav, notInNav } = parseMkdocsNav(fs.readFileSync(mkdocsYml, "utf8"));
    const files = new Set(listMarkdown(docsDir).map((rel) => rel.replace(/\.md$/, "")));
    const missing = nav.filter((n) => !files.has(n.slug)).map((n) => n.slug);
    const stray = [...files].filter(
      (f) => !nav.some((n) => n.slug === f) && !notInNav.some((re) => re.test(`${f}.md`)),
    );
    if (missing.length || stray.length)
      throw new Error(
        `mkdocs.yml and docs/ disagree:${missing.map((m) => `\n  in the nav, no file: ${m}.md`).join("")}` +
          stray.map((f) => `\n  no nav entry and not in not_in_nav: ${f}.md`).join(""),
      );
    // the dated records outside the nav stay out of the in-app reader
    const pages = nav.map((n, order) => ({
      ...n,
      order,
      body: fs.readFileSync(path.join(docsDir, `${n.slug}.md`), "utf8"),
    }));
    return `export const DOC_PAGES = ${JSON.stringify(pages)};\n`;
  };

  return {
    name: "aprscaching-docs",
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      return null;
    },
    load(id) {
      if (id === RESOLVED_ID) return build();
      return null;
    },
    configureServer(server) {
      // Dev HMR: editing a manual page or the nav invalidates the virtual module and reloads.
      server.watcher.add([docsDir, mkdocsYml]);
      const onChange = (file: string) => {
        const f = path.resolve(file);
        if (!f.startsWith(path.resolve(docsDir)) && f !== path.resolve(mkdocsYml)) return;
        const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: "full-reload" });
      };
      server.watcher.on("add", onChange).on("change", onChange).on("unlink", onChange);
    },
  };
}
