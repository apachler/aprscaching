// SPDX-License-Identifier: AGPL-3.0-or-later
// The in-app manual takes its contents from mkdocs.yml: the parser reads sections, nested groups and top-level
// pages, and the real nav and docs/ agree — every nav entry has a file, and every page is in the nav or kept out
// of it on purpose (not_in_nav).
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseMkdocsNav } from "../vite-docs.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("parseMkdocsNav", () => {
  const yml = [
    "site_name: x",
    "nav:",
    "  - Home: index.md",
    "  - Play:",
    "      - What is it?: play/index.md",
    "      - Cache types:",
    "          - Overview: play/cache-types/index.md",
    '      - "Pocket: a phone": run/pocket.md',
    "  - Glossary: glossary.md",
    "not_in_nav: |",
    "  reviews/*",
    "markdown_extensions:",
    "  - pymdownx.superfences:",
    "      custom_fences:",
    "        - name: mermaid",
    "          format: !!python/name:pymdownx.superfences.fence_code_format",
  ].join("\n");

  it("keeps order, sections and titles, nested groups under their top-level section", () => {
    expect(parseMkdocsNav(yml).pages).toEqual([
      { slug: "index", title: "Home", section: "" },
      { slug: "play/index", title: "What is it?", section: "Play" },
      { slug: "play/cache-types/index", title: "Overview", section: "Play" },
      { slug: "run/pocket", title: "Pocket: a phone", section: "Play" },
      { slug: "glossary", title: "Glossary", section: "" },
    ]);
  });

  it("reads not_in_nav as patterns", () => {
    const { notInNav } = parseMkdocsNav(yml);
    expect(notInNav.some((re) => re.test("reviews/doc-inventory.md"))).toBe(true);
    expect(notInNav.some((re) => re.test("play/index.md"))).toBe(false);
  });
});

describe("mkdocs.yml and docs/", () => {
  const { pages, notInNav } = parseMkdocsNav(readFileSync(join(ROOT, "mkdocs.yml"), "utf8"));
  const walk = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? walk(join(d, e.name))
        : e.name.endsWith(".md")
          ? [relative(join(ROOT, "docs"), join(d, e.name))]
          : [],
    );
  const files = walk(join(ROOT, "docs")).map((f) => f.split("\\").join("/"));

  it("has a file for every nav entry", () => {
    expect(pages.filter((p) => !files.includes(`${p.slug}.md`)).map((p) => p.slug)).toEqual([]);
  });

  it("lists every page, or keeps it out of the nav on purpose", () => {
    const listed = new Set(pages.map((p) => `${p.slug}.md`));
    expect(files.filter((f) => !listed.has(f) && !notInNav.some((re) => re.test(f)))).toEqual([]);
  });
});
