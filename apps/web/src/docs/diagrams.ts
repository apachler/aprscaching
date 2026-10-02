// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Draws the manual's Mermaid diagrams in the in-app reader. markdown.ts leaves each ```mermaid block as a
 * `[data-mermaid]` placeholder holding its source as a code block; this draws the diagram beside it and hides
 * the code. Mermaid is large, so it is imported only when a page has a diagram, and a page without one never
 * loads it. Its colours
 * are the diagram tokens of the applied theme, resolved to #rrggbb (Mermaid cannot read custom properties or
 * OKLCH), so a theme change draws the page again. securityLevel "strict" keeps labels as text: no HTML, no
 * click handlers. A diagram that fails to parse keeps its source, so the reader still sees what it says.
 */
import { tokenHex } from "../shell/tokenColor.js";

function themeVariables(): Record<string, string> {
  const node = tokenHex("--diagram-node-bg");
  const line = tokenHex("--diagram-node-line");
  const ink = tokenHex("--diagram-ink");
  const edge = tokenHex("--diagram-edge");
  const label = tokenHex("--diagram-label-bg");
  const group = tokenHex("--diagram-group-bg");
  return {
    fontFamily: getComputedStyle(document.body).fontFamily || "system-ui, sans-serif",
    background: tokenHex("--surface"),
    primaryColor: node,
    primaryBorderColor: line,
    primaryTextColor: ink,
    secondaryColor: group,
    tertiaryColor: group,
    mainBkg: node,
    nodeBorder: line,
    nodeTextColor: ink,
    textColor: ink,
    titleColor: ink,
    lineColor: edge,
    clusterBkg: group,
    clusterBorder: edge,
    edgeLabelBackground: label,
    actorBkg: node,
    actorBorder: line,
    actorTextColor: ink,
    actorLineColor: edge,
    signalColor: edge,
    signalTextColor: ink,
    labelBoxBkgColor: node,
    labelBoxBorderColor: line,
    labelTextColor: ink,
    loopTextColor: ink,
    noteBkgColor: group,
    noteBorderColor: edge,
    noteTextColor: ink,
    sequenceNumberColor: label,
  };
}

/** Draw every diagram placeholder under ROOT; resolves once all are drawn or have kept their source. */
export async function drawDiagrams(root: HTMLElement, isCurrent: () => boolean): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>("[data-mermaid]")];
  if (!blocks.length) return;
  const { default: mermaid } = await import("mermaid");
  if (!isCurrent()) return;
  // dagre, not Mermaid's default ELK, which this bundle leaves out (noElk.ts); the manual lays out the same way.
  // A diagram that fails keeps its source instead of Mermaid's error picture.
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: "base",
    layout: "dagre",
    themeVariables: themeVariables(),
  });
  for (const block of blocks) {
    const code = block.querySelector("pre");
    const source = block.dataset.source ?? code?.textContent ?? "";
    block.dataset.source = source;
    // Mermaid draws into a fresh element holding the source as text; the code block stays as the fallback
    block.querySelector(".doc-diagram-drawn")?.remove();
    const fig = document.createElement("div");
    fig.className = "doc-diagram-drawn";
    fig.setAttribute("role", "img");
    fig.setAttribute("aria-label", "Diagram");
    fig.textContent = source;
    fig.dataset.drawing = ""; // laid out but unseen: Mermaid measures the text as it draws
    block.append(fig);
    try {
      await mermaid.run({ nodes: [fig] });
      if (!isCurrent()) return;
      if (!fig.querySelector("svg")) throw new Error("not drawn");
      delete fig.dataset.drawing;
      if (code) code.hidden = true;
      block.dataset.drawn = "";
    } catch {
      fig.remove();
      if (code) code.hidden = false;
      delete block.dataset.drawn;
    }
  }
}
