// SPDX-License-Identifier: AGPL-3.0-or-later
// Labels in the source, read with the TypeScript parser: no <label> holds a button (an InfoTip or a Button). A label
// labels its first labelable descendant, and a button is one, so a button inside it would take the label's name and
// its clicks from the field the label is for.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");
const BUTTONS = new Set(["InfoTip", "Button", "button"]);

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? tsxFiles(p) : p.endsWith(".tsx") ? [p] : [];
  });
}

function scan(): { labels: number; holding: string[] } {
  let labels = 0;
  const holding: string[] = [];
  for (const file of tsxFiles(SRC)) {
    const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const tagOf = (n: ts.Node) =>
      ts.isJsxSelfClosingElement(n)
        ? n.tagName.getText()
        : ts.isJsxElement(n)
          ? n.openingElement.tagName.getText()
          : null;
    const holds = (n: ts.Node): boolean => {
      const t = tagOf(n);
      if (t && BUTTONS.has(t)) return true;
      return ts.forEachChild(n, (c) => (holds(c) ? true : undefined)) ?? false;
    };
    const visit = (n: ts.Node) => {
      if (ts.isJsxElement(n) && tagOf(n) === "label") {
        labels++;
        if (n.children.some(holds)) {
          const line = src.getLineAndCharacterOfPosition(n.getStart()).line + 1;
          holding.push(`${relative(SRC, file)}:${line}`);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  return { labels, holding };
}

describe("labels", () => {
  const { labels, holding } = scan();

  it("finds the labels", () => expect(labels).toBeGreaterThan(50));

  it("hold no button, so they label their field", () => expect(holding).toEqual([]));
});
