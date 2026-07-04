// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * vite-docs — bundle the repo's `docs/` markdown manual straight into the SPA at build time, so the
 * platform serves its own documentation with no MkDocs, no static-site step, and no extra container.
 * The markdown stays the single source of truth (MkDocs still builds the same files for the public
 * site); this plugin just exposes them to the app as a `virtual:docs` module of `{ slug, title,
 * section, order, body }` records. Rendering happens client-side (see src/docs/markdown.ts).
 */
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

const VIRTUAL_ID = "virtual:docs";
const RESOLVED_ID = "\0" + VIRTUAL_ID;

// Section + order mirror mkdocs.yml `nav` (kept in sync by hand — it's a short list). Any doc NOT
// listed here still appears: grouped by its top-level directory and sorted after the known pages, so
// a newly-added file is never silently dropped — just unordered until it's added here.
const NAV: { slug: string; section: string; title: string }[] = [
  { slug: "index", section: "Overview", title: "Overview" },
  { slug: "getting-started", section: "Overview", title: "Getting started" },
  { slug: "concepts", section: "Overview", title: "Core concepts" },
  { slug: "guides/caching", section: "Guides", title: "Caching" },
  { slug: "guides/workbench", section: "Guides", title: "The workbench" },
  { slug: "guides/federation", section: "Guides", title: "Federation" },
  { slug: "operate/deployment", section: "Operating an instance", title: "Deployment" },
  { slug: "operate/rf-ingest", section: "Operating an instance", title: "RF ingest & transports" },
  { slug: "operate/packet", section: "Operating an instance", title: "Packet BBS & node" },
  { slug: "operate/rig-weather", section: "Operating an instance", title: "Rig control & weather" },
  { slug: "operate/rf-regulatory", section: "Operating an instance", title: "Amateur-radio compliance" },
  { slug: "operate/administration", section: "Operating an instance", title: "Administration" },
  { slug: "reference/api", section: "Reference", title: "HTTP API" },
  { slug: "reference/configuration", section: "Reference", title: "Configuration" },
  { slug: "reference/cli", section: "Reference", title: "Command-line tools" },
  { slug: "reference/data-model", section: "Reference", title: "Data model" },
  { slug: "about", section: "About", title: "About" },
];

const SECTION_FOR_DIR: Record<string, string> = {
  guides: "Guides",
  operate: "Operating an instance",
  reference: "Reference",
};

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

function firstHeading(md: string): string | null {
  const m = /^#\s+(.+?)\s*$/m.exec(md);
  return m ? m[1]! : null;
}

export function docsPlugin(docsDir: string): Plugin {
  const build = () => {
    const pages = listMarkdown(docsDir)
      .map((rel) => {
        const slug = rel.replace(/\.md$/, "");
        const body = fs.readFileSync(path.join(docsDir, rel), "utf8");
        const nav = NAV.find((n) => n.slug === slug);
        const title = nav?.title ?? firstHeading(body) ?? slug;
        const section = nav?.section ?? SECTION_FOR_DIR[slug.split("/")[0]!] ?? "More";
        const order = nav ? NAV.indexOf(nav) : 1000 + slug.length;
        return { slug, title, section, order, body };
      })
      .sort((a, b) => a.order - b.order);
    return `export const DOC_PAGES = ${JSON.stringify(pages)};\n`;
  };

  return {
    name: "aprsweb-docs",
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
      return null;
    },
    load(id) {
      if (id === RESOLVED_ID) return build();
      return null;
    },
    configureServer(server) {
      // Dev HMR: editing a manual page invalidates the virtual module and reloads.
      server.watcher.add(docsDir);
      const onChange = (file: string) => {
        if (!path.resolve(file).startsWith(path.resolve(docsDir))) return;
        const mod = server.moduleGraph.getModuleById(RESOLVED_ID);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: "full-reload" });
      };
      server.watcher.on("add", onChange).on("change", onChange).on("unlink", onChange);
    },
  };
}
