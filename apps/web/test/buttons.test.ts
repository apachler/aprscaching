// SPDX-License-Identifier: AGPL-3.0-or-later
// Buttons in the source, read with the TypeScript parser: every button outside the ui/ primitives is the Button
// component, and every icon-only Button carries an accessible name (WCAG 4.1.2: aria-label, or the hint it takes as
// its name), since its icon has none.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? tsxFiles(p) : p.endsWith(".tsx") ? [p] : [];
  });
}

interface Found {
  where: string;
  tag: string;
  attrs: Map<string, string>;
}

function elements(): Found[] {
  const out: Found[] = [];
  for (const file of tsxFiles(SRC)) {
    const src = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (n: ts.Node) => {
      const open = ts.isJsxSelfClosingElement(n) ? n : ts.isJsxElement(n) ? n.openingElement : null;
      if (open) {
        const tag = open.tagName.getText();
        if (tag === "button" || tag === "Button") {
          const attrs = new Map<string, string>();
          for (const a of open.attributes.properties) {
            if (ts.isJsxAttribute(a)) attrs.set(a.name.getText(), a.initializer ? a.initializer.getText() : "true");
            else attrs.set("...spread", a.getText());
          }
          const line = src.getLineAndCharacterOfPosition(open.getStart()).line + 1;
          out.push({ where: `${relative(SRC, file)}:${line}`, tag, attrs });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  return out;
}

describe("buttons", () => {
  const all = elements();

  it("finds the buttons", () => expect(all.length).toBeGreaterThan(150));

  it("are the Button component outside the ui/ primitives", () => {
    const raw = all.filter((b) => b.tag === "button" && !b.where.startsWith("ui/")).map((b) => b.where);
    expect(raw).toEqual([]);
  });

  it("have an accessible name when they show only an icon", () => {
    const unnamed = all
      .filter((b) => /^"icon(-subtle)?"$/.test(b.attrs.get("variant") ?? ""))
      .filter((b) => !["aria-label", "hint", "title", "...spread"].some((a) => b.attrs.has(a)))
      .map((b) => b.where);
    expect(unnamed).toEqual([]);
  });
});
