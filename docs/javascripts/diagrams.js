// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * Draws the manual's diagrams. A ```mermaid block arrives as <pre class="diagram"> (mkdocs.yml); on a page
 * that has one, this loads the self-hosted Mermaid (assets/vendor/, copied from the web app's locked
 * dependency by tools/dev/docs-theme.mjs) and draws each block in the colours of the reader's scheme: the
 * app's diagram tokens, resolved to #rrggbb because Mermaid cannot read custom properties or OKLCH. The
 * in-app reader (apps/web/src/docs/diagrams.ts) draws the same blocks the same way. Switching the scheme
 * draws them again. A block that cannot be drawn keeps its source.
 */
(function () {
  var blocks = Array.prototype.slice.call(document.querySelectorAll("pre.diagram"));
  if (!blocks.length) return;
  var here = document.currentScript && document.currentScript.src;
  var seq = 0;

  function hex(name) {
    var probe = document.createElement("span");
    probe.style.color = "var(" + name + ")";
    document.body.appendChild(probe);
    var css = getComputedStyle(probe).color;
    probe.remove();
    var c = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
    c.fillStyle = css;
    c.fillRect(0, 0, 1, 1);
    var d = c.getImageData(0, 0, 1, 1).data;
    return "#" + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("");
  }

  function themeVariables() {
    var node = hex("--diagram-node-bg"),
      line = hex("--diagram-node-line"),
      ink = hex("--diagram-ink"),
      edge = hex("--diagram-edge"),
      label = hex("--diagram-label-bg"),
      group = hex("--diagram-group-bg");
    return {
      fontFamily: getComputedStyle(document.body).fontFamily,
      background: hex("--surface"),
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

  async function draw() {
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      layout: "dagre", // as the in-app reader, whose bundle leaves ELK out
      themeVariables: themeVariables(),
    });
    for (var pre of blocks) {
      var source = pre.dataset.source || pre.textContent;
      pre.dataset.source = source;
      try {
        var out = await window.mermaid.render("diagram-" + ++seq, source);
        var fig = pre.nextElementSibling && pre.nextElementSibling.classList.contains("diagram-drawn") ? pre.nextElementSibling : null;
        if (!fig) {
          fig = document.createElement("div");
          fig.className = "diagram-drawn";
          fig.setAttribute("role", "img");
          fig.setAttribute("aria-label", "Diagram");
          pre.after(fig);
        }
        fig.innerHTML = out.svg;
        pre.hidden = true;
      } catch (e) {
        pre.hidden = false;
      }
    }
  }

  var script = document.createElement("script");
  script.src = new URL("../assets/vendor/mermaid.min.js", here).href;
  script.onload = function () {
    draw();
    new MutationObserver(draw).observe(document.body, { attributes: true, attributeFilter: ["data-md-color-scheme"] });
  };
  document.head.appendChild(script);
})();
