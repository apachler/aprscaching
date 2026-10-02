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

  // A computed colour as #rrggbb. Browsers report it in different forms (Chromium color(srgb …) or rgb(),
  // Firefox and Safari oklab() or oklch()), and a canvas does not parse all of them everywhere, so the common
  // forms are converted here, as apps/web/src/shell/tokenColor.ts does; anything else goes through a canvas.
  function toHex(rgb) {
    return "#" + rgb.map((v) => Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, "0")).join("");
  }
  function gamma(x) {
    return 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
  }
  function num(s, scale) {
    return s === "none" ? 0 : s.endsWith("%") ? (parseFloat(s) / 100) * (scale || 1) : parseFloat(s);
  }
  function oklab(l, a, b) {
    var l_ = Math.pow(l + 0.3963377774 * a + 0.2158037573 * b, 3),
      m_ = Math.pow(l - 0.1055613458 * a - 0.0638541728 * b, 3),
      s_ = Math.pow(l - 0.0894841775 * a - 1.291485548 * b, 3);
    return [
      4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
      -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
      -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
    ].map(gamma);
  }
  function parse(css) {
    var m = /^\s*([a-z]+)\(\s*([^)]*)\)\s*$/i.exec(css);
    if (!m) return null;
    var fn = m[1].toLowerCase(),
      p = m[2].split(/[\s,/]+/).filter(Boolean);
    if ((fn === "rgb" || fn === "rgba") && p.length >= 3) return toHex(p.slice(0, 3).map((x) => num(x, 255)));
    if (fn === "color" && p[0] === "srgb" && p.length >= 4) return toHex(p.slice(1, 4).map((x) => num(x) * 255));
    if (fn === "oklab" && p.length >= 3) return toHex(oklab(num(p[0]), num(p[1], 0.4), num(p[2], 0.4)));
    if (fn === "oklch" && p.length >= 3) {
      var c = num(p[1], 0.4),
        h = (num(p[2]) * Math.PI) / 180;
      return toHex(oklab(num(p[0]), c * Math.cos(h), c * Math.sin(h)));
    }
    return null;
  }

  function hex(name) {
    var probe = document.createElement("span");
    probe.style.color = "var(" + name + ")";
    document.body.appendChild(probe);
    var css = getComputedStyle(probe).color;
    probe.remove();
    var parsed = parse(css);
    if (parsed) return parsed;
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
      suppressErrorRendering: true, // a diagram that fails keeps its source, not Mermaid's error picture
      theme: "base",
      layout: "dagre", // as the in-app reader, whose bundle leaves ELK out
      themeVariables: themeVariables(),
    });
    for (var pre of blocks) {
      var source = pre.dataset.source || pre.textContent;
      pre.dataset.source = source;
      // Mermaid draws into a fresh element holding the source as text; the code block stays as the fallback
      var old = pre.nextElementSibling;
      if (old && old.classList.contains("diagram-drawn")) old.remove();
      var fig = document.createElement("div");
      fig.className = "diagram-drawn";
      fig.setAttribute("role", "img");
      fig.setAttribute("aria-label", "Diagram");
      fig.textContent = source;
      fig.dataset.drawing = ""; // laid out but unseen: Mermaid measures the text as it draws
      pre.after(fig);
      try {
        await window.mermaid.run({ nodes: [fig] });
        if (!fig.querySelector("svg")) throw new Error("not drawn");
        delete fig.dataset.drawing;
        pre.hidden = true;
      } catch (e) {
        fig.remove();
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
