// SPDX-License-Identifier: MIT
// MHeard 1.0.0, built by scripts/build.mjs from tools/mheard/src, lib/ and the
// aprscaching libraries lib.lock pins. Edit the sources, not this file.
(() => {
  // lib/text.js
  function ago(ms, now = Date.now()) {
    const s = Math.max(0, Math.floor((now - ms) / 1e3));
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
  }
  var asStr = (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : "";
  var callOf = (v) => asStr(v).trim().toUpperCase();

  // tools/mheard/src/index.js
  var SHOWN = 14;
  var KEPT = 500;
  var heard = /* @__PURE__ */ new Map();
  function rebuild() {
    const rows = [...heard].sort((a, b) => b[1].ts - a[1].ts).slice(0, SHOWN).map(([call, h]) => [call, h.src || "—", `${ago(h.ts)} ago`]);
    tool.setPanel({
      title: "MHeard",
      nodes: rows.length ? [{ kind: "table", head: ["Station", "Src", "Heard"], rows }] : [{ kind: "text", text: "Nothing heard yet.", tone: "muted" }]
    });
  }
  tool.on("on_frame", (p) => {
    const call = callOf(p.peerCall);
    if (!call) return;
    heard.delete(call);
    heard.set(call, { ts: Date.now(), src: asStr(p.source) });
    if (heard.size > KEPT) heard.delete(heard.keys().next().value);
    rebuild();
  });
  tool.on("on_tick", rebuild);
  rebuild();
})();
