// SPDX-License-Identifier: AGPL-3.0-or-later
// Semantics in the source, read with the TypeScript parser: no element plays a button through role="button" (a real
// button is the Button component, css.md), and no generic span or div carries an aria-label without a role, since
// ARIA gives a generic element no name and screen readers skip it (an "unread" mark is visually hidden text instead).
// A button that opens and closes a part of the page says whether it is open, with aria-expanded. A modal dialog sits
// on a backdrop or scrim that covers the page, since aria-modal tells assistive tech that the rest of it is inert.
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
  /** The className of the nearest JSX element around this one. */
  parentClass?: string;
  /** The tags of every JSX element around this one in its file. */
  ancestors: string[];
  /** The top-level function this element is in renders a Panel, whose title is the level-2 heading. */
  inPanel: boolean;
}

function elements(): Found[] {
  const out: Found[] = [];
  for (const file of tsxFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (n: ts.Node) => {
      const open = ts.isJsxSelfClosingElement(n) ? n : ts.isJsxElement(n) ? n.openingElement : null;
      if (open) {
        const attrs = new Map<string, string>();
        for (const a of open.attributes.properties)
          if (ts.isJsxAttribute(a)) attrs.set(a.name.getText(), a.initializer ? a.initializer.getText() : "true");
        const line = src.getLineAndCharacterOfPosition(open.getStart()).line + 1;
        const ancestors: string[] = [];
        for (let a = n.parent; a; a = a.parent)
          if (ts.isJsxElement(a)) ancestors.push(a.openingElement.tagName.getText());
        let top: ts.Node = n;
        while (top.parent && !ts.isSourceFile(top.parent)) top = top.parent;
        const inPanel = /<(Panel|AppPanel)\b/.test(top.getText());
        let up = n.parent;
        while (up && !ts.isJsxElement(up)) up = up.parent;
        const parentClass = up
          ? up.openingElement.attributes.properties
              .filter(ts.isJsxAttribute)
              .find((a) => a.name.getText() === "className")
              ?.initializer?.getText()
          : undefined;
        out.push({
          where: `${relative(SRC, file)}:${line}`,
          tag: open.tagName.getText(),
          attrs,
          parentClass,
          ancestors,
          inPanel,
        });
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  return out;
}

describe("element semantics", () => {
  const all = elements();

  it("finds the elements", () => expect(all.length).toBeGreaterThan(1000));

  it("never make a button out of another element", () =>
    expect(all.filter((e) => e.attrs.get("role") === '"button"').map((e) => e.where)).toEqual([]));

  it("say whether what they open is open", () => {
    const toggles = all.filter(
      (e) => /^button$|^Button$/.test(e.tag) && /set\w*Open\(\((\w+)\) => !\1\)/.test(e.attrs.get("onClick") ?? ""),
    );
    expect(toggles.length).toBeGreaterThan(3);
    expect(toggles.filter((e) => !e.attrs.has("aria-expanded")).map((e) => e.where)).toEqual([]);
  });

  it("put a modal dialog on a backdrop over the page", () => {
    const modal = all.filter((e) => e.attrs.get("aria-modal") === '"true"');
    expect(modal.length).toBeGreaterThan(3);
    expect(modal.filter((e) => !/backdrop|scrim/.test(e.parentClass ?? "")).map((e) => e.where)).toEqual([]);
  });

  // a group's title is the level-3 heading (ui/Group.tsx), so a level-4 heading in the component that renders a panel
  // sits inside a group (a component of its own is read as the content of a group)
  it("keep a panel's headings one level apart", () => {
    const h4 = all.filter((e) => e.inPanel && e.tag === "h4");
    expect(all.filter((e) => e.inPanel && e.tag === "Group").length).toBeGreaterThan(5);
    expect(h4.filter((e) => !e.ancestors.includes("Group")).map((e) => e.where)).toEqual([]);
  });

  it("never name a generic span or div with aria-label", () =>
    expect(
      all
        .filter((e) => (e.tag === "span" || e.tag === "div") && e.attrs.has("aria-label") && !e.attrs.has("role"))
        .map((e) => e.where),
    ).toEqual([]));
});
