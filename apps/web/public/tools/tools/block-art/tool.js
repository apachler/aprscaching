// SPDX-License-Identifier: MIT
// Block art (GIP) 1.0.0, built by scripts/build.mjs from tools/block-art/src, lib/ and the
// aprscaching libraries lib.lock pins. Edit the sources, not this file.
(() => {
  // vendor/aprscaching/packages/tools/src/panel.ts
  function parseBlocks(text, cap = 4e3) {
    const lines = String(text).replace(/\r/g, "").split("\n").slice(0, 64);
    const cols = Math.max(
      1,
      Math.min(
        200,
        lines.reduce((m, l) => Math.max(m, l.length), 0)
      )
    );
    const cells = [];
    for (const line of lines) for (let x = 0; x < cols && cells.length < cap; x++) cells.push({ ch: line[x] ?? " " });
    return { kind: "blocks", cols, cells };
  }
  var TONES = /* @__PURE__ */ new Set(["default", "muted", "accent", "ok", "warn", "bad"]);
  var tone = (t) => TONES.has(t) ? t : void 0;
  var str = (x, cap = 240) => (typeof x === "string" ? x : typeof x === "number" || typeof x === "boolean" || typeof x === "bigint" ? String(x) : "").slice(0, cap);
  function sanitizePanel(input) {
    const o = input && typeof input === "object" ? input : {};
    const rawNodes = Array.isArray(o.nodes) ? o.nodes.slice(0, 60) : [];
    const nodes = [];
    for (const n of rawNodes) {
      if (!n || typeof n !== "object") continue;
      const d = n;
      switch (d.kind) {
        case "text":
          nodes.push({ kind: "text", text: str(d.text), tone: tone(d.tone) });
          break;
        case "kv":
          nodes.push({ kind: "kv", key: str(d.key, 60), value: str(d.value), tone: tone(d.tone) });
          break;
        case "badge":
          nodes.push({ kind: "badge", text: str(d.text, 40), tone: tone(d.tone) });
          break;
        case "bar":
          nodes.push({
            kind: "bar",
            label: str(d.label, 60),
            value: Number(d.value) || 0,
            max: Number(d.max) || 1,
            tone: tone(d.tone)
          });
          break;
        case "table": {
          const head = (Array.isArray(d.head) ? d.head : []).slice(0, 8).map((h) => str(h, 40));
          const rows = (Array.isArray(d.rows) ? d.rows : []).slice(0, 100).map((r) => (Array.isArray(r) ? r : []).slice(0, 8).map((c) => str(c, 80)));
          nodes.push({ kind: "table", head, rows });
          break;
        }
        case "blocks": {
          const cols = Math.max(1, Math.min(200, Math.floor(Number(d.cols) || 1)));
          const cells = (Array.isArray(d.cells) ? d.cells : []).slice(0, 4e3).map((cell) => {
            const o2 = cell && typeof cell === "object" ? cell : {};
            const ch = (typeof o2.ch === "string" ? o2.ch : " ").slice(0, 1) || " ";
            const c = Number(o2.c);
            return Number.isInteger(c) && c >= 0 && c <= 15 ? { ch, c } : { ch };
          });
          nodes.push({ kind: "blocks", cols, cells });
          break;
        }
        default:
          break;
      }
    }
    return { title: typeof o.title === "string" ? str(o.title, 80) : void 0, nodes };
  }

  // tools/block-art/src/index.js
  var SAMPLE = [
    '  .-"""-.',
    " / .===. \\",
    " \\/ 6 6 \\/",
    " ( \\___/ )   APRScaching",
    "  \\_____/    de OE8APR"
  ].join("\n");
  var showText = (text) => tool.setPanel({ title: "Block art", nodes: [parseBlocks(text)] });
  register({
    commands: {
      art: (args) => {
        if (!args.trim()) {
          showText(SAMPLE);
          return ["Rendered the sample. /art <text> to render your own CP437/ANSI art."];
        }
        showText(args.replace(/\\n/g, "\n"));
        return ["Rendered."];
      }
    }
  });
  tool.subscribe("render.blocks", (data) => {
    const d = data ?? {};
    if (typeof d.text === "string") showText(d.text);
    else if (Array.isArray(d.cells))
      tool.setPanel(sanitizePanel({ title: "Block art", nodes: [{ kind: "blocks", cols: d.cols, cells: d.cells }] }));
  });
  showText(SAMPLE);
})();
