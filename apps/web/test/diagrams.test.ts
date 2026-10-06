// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// Every ```mermaid block in the repository's Markdown parses with the Mermaid the published manual ships
// (tools/dev/docs-theme.mjs copies this package's locked build into the site), so a diagram never reaches a reader
// as a syntax error.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

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

// Loading Mermaid under jsdom and parsing a large diagram take seconds when the whole suite runs in parallel:
// load it once up front, and give each parse room.
describe("Mermaid diagrams in the docs", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    await import("mermaid");
  }, 60_000);

  it.each(DIAGRAMS.map((d) => [`${d.file}:${d.line}`, d.source] as const))("%s parses", async (_where, source) => {
    const { default: mermaid } = await import("mermaid");
    await expect(mermaid.parse(source)).resolves.toBeTruthy();
  });
});
