// SPDX-License-Identifier: AGPL-3.0-or-later
// Form fields in the source, read with the TypeScript parser: every input, select and textarea has a label (ui-ux.md
// §7) — a <label> or a Field around it, aria-label, aria-labelledby, or an id that a label's htmlFor names. A
// placeholder is no label: it shows an example and is gone once the field holds text.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");
const FIELDS = new Set(["input", "select", "textarea"]);
/** Inputs that are not fields a person fills in with words, or that take their name from a primitive. */
const NOT_NAMED_HERE = /^"(hidden|file|checkbox|radio)"$/;

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? tsxFiles(p) : p.endsWith(".tsx") ? [p] : [];
  });
}

function scan(): { fields: number; unlabelled: string[] } {
  let fields = 0;
  const unlabelled: string[] = [];
  for (const file of tsxFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (n: ts.Node, inLabel: boolean) => {
      const open = ts.isJsxSelfClosingElement(n) ? n : ts.isJsxElement(n) ? n.openingElement : null;
      const tag = open?.tagName.getText();
      if (open && tag && FIELDS.has(tag)) {
        const attrs = new Map<string, string>();
        for (const a of open.attributes.properties)
          if (ts.isJsxAttribute(a)) attrs.set(a.name.getText(), a.initializer ? a.initializer.getText() : "true");
          else attrs.set("...spread", a.getText());
        if (!NOT_NAMED_HERE.test(attrs.get("type") ?? "")) {
          fields++;
          const named =
            inLabel ||
            ["aria-label", "aria-labelledby", "...spread"].some((a) => attrs.has(a)) ||
            (attrs.has("id") && text.includes("htmlFor"));
          if (!named)
            unlabelled.push(`${relative(SRC, file)}:${src.getLineAndCharacterOfPosition(open.getStart()).line + 1}`);
        }
      }
      const labelling = tag === "label" || tag === "Field";
      ts.forEachChild(n, (c) => visit(c, inLabel || labelling));
    };
    visit(src, false);
  }
  return { fields, unlabelled };
}

describe("form fields", () => {
  const { fields, unlabelled } = scan();

  it("finds the fields", () => expect(fields).toBeGreaterThan(80));

  it("each have a label", () => expect(unlabelled).toEqual([]));
});
