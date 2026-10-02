// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// Every ```mermaid block in the repository's Markdown parses with the Mermaid the app and the manual ship, so a
// diagram never reaches a reader as a syntax error; and the in-app renderer leaves each block as a placeholder
// that shows its source until it is drawn.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/docs/markdown.js";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const FILES = execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);

function blocks(file: string): { line: number; source: string }[] {
  const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
  const found: { line: number; source: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*```mermaid\s*$/.test(lines[i]!)) continue;
    const start = i + 1;
    const body: string[] = [];
    while (++i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i]!);
    found.push({ line: start, source: body.join("\n") });
  }
  return found;
}

const DIAGRAMS = FILES.flatMap((file) => blocks(file).map((b) => ({ file, ...b })));

describe("Mermaid diagrams in the docs", () => {
  it.each(DIAGRAMS.map((d) => [`${d.file}:${d.line}`, d.source] as const))("%s parses", async (_where, source) => {
    const { default: mermaid } = await import("mermaid");
    await expect(mermaid.parse(source)).resolves.toBeTruthy();
  });

  it("the in-app renderer keeps a diagram's source in a placeholder", () => {
    const html = renderMarkdown("```mermaid\nflowchart LR\n  a --> b\n```", "x");
    expect(html).toBe(
      '<div class="doc-diagram" data-mermaid><pre><code class="lang-mermaid">flowchart LR\n  a --&gt; b</code></pre></div>',
    );
  });

  it("an admonition title renders its inline Markdown", () => {
    const html = renderMarkdown('!!! tip "New here? [Start here](play/index.md)"\n    Body.', "index");
    expect(html).toContain(
      '<p class="doc-adm-t">New here? <a href="?view=docs&doc=play%2Findex" data-doc="play/index"',
    );
  });
});
