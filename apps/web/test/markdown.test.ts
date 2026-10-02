// SPDX-License-Identifier: AGPL-3.0-or-later
// The in-app manual's lists: an item's wrapped lines stay in the item, a code block or paragraph indented under
// an item belongs to it, a nested list hangs off its parent, and an ordered list keeps counting across them.
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/docs/markdown.js";

describe("renderMarkdown lists", () => {
  it("keeps a wrapped item's lines in the item", () => {
    expect(renderMarkdown("1. Install **Termux** from\n   F-Droid, not the Play Store.\n2. Run it.", "x")).toBe(
      "<ol><li>Install <strong>Termux</strong> from F-Droid, not the Play Store.</li><li>Run it.</li></ol>",
    );
  });

  it("puts an indented code block and paragraph inside the item, and counts on", () => {
    const md = [
      "1. Get it:",
      "",
      "    ```bash",
      "    curl -fsSLO https://example.net/pocket.sh",
      "    ```",
      "",
      "    It checks the file.",
      "2. Run it.",
    ].join("\n");
    expect(renderMarkdown(md, "x")).toBe(
      '<ol><li>Get it:<pre><code class="lang-bash">curl -fsSLO https://example.net/pocket.sh</code></pre>\n' +
        "<p>It checks the file.</p></li><li>Run it.</li></ol>",
    );
  });

  it("hangs a nested list off its parent item", () => {
    expect(renderMarkdown("- a\n  - b\n  - c\n- d", "x")).toBe(
      "<ul><li>a<ul><li>b</li><li>c</li></ul></li><li>d</li></ul>",
    );
  });

  it("keeps one list across blank lines between items, and starts where it starts", () => {
    expect(renderMarkdown("3. three\n\n4. four", "x")).toBe('<ol start="3"><li>three</li><li>four</li></ol>');
  });

  it("ends the list at an unindented paragraph", () => {
    expect(renderMarkdown("- a\n\nAfter.", "x")).toBe("<ul><li>a</li></ul>\n<p>After.</p>");
  });
});

describe("renderMarkdown inline", () => {
  it("keeps a bare number beside inline code", () => {
    expect(renderMarkdown("Wait 5 minutes, then run `start` again 2 times.", "x")).toBe(
      "<p>Wait 5 minutes, then run <code>start</code> again 2 times.</p>",
    );
  });
});

describe("renderMarkdown comments", () => {
  it("drops HTML comments, so a marker above a table leaves the table intact", () => {
    expect(renderMarkdown("<!-- config-table:web -->\n| a | b |\n|---|---|\n| 1 | 2 |", "x")).toBe(
      "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
    );
    expect(renderMarkdown("Text <!-- vale Vale.Terms = NO -->here.", "x")).toBe("<p>Text here.</p>");
  });
});
