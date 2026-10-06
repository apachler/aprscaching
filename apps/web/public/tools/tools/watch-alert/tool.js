// SPDX-License-Identifier: MIT
// Watch & alert 1.1.0, built by scripts/build.mjs from tools/watch-alert/src, lib/ and the
// aprscaching libraries lib.lock pins. Edit the sources, not this file.
(() => {
  // lib/text.js
  function ago(ms, now = Date.now()) {
    const s = Math.max(0, Math.floor((now - ms) / 1e3));
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
  }
  var asStr = (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : "";
  var callOf = (v) => asStr(v).trim().toUpperCase();

  // tools/watch-alert/src/index.js
  var watched = /* @__PURE__ */ new Set();
  var hits = /* @__PURE__ */ new Map();
  var base = (call) => call.split("-")[0];
  var match = (call) => watched.has(call) ? call : watched.has(base(call)) ? base(call) : null;
  function rebuild() {
    const rows = [...watched].map((c) => [c, hits.has(c) ? `${ago(hits.get(c))} ago` : "—"]);
    tool.setPanel({
      title: "Watch",
      nodes: rows.length ? [{ kind: "table", head: ["Call", "Last heard"], rows }] : [{ kind: "text", text: "No calls watched — /watch <CALL>", tone: "muted" }]
    });
    tool.setColourRules(
      [...watched].flatMap(
        (c) => c.includes("-") ? [{ src: c, colorVar: "--warn" }] : [
          { src: c, colorVar: "--warn" },
          { srcPrefix: `${c}-`, colorVar: "--warn" }
        ]
      )
    );
  }
  register({
    commands: {
      watch: (args) => {
        const c = callOf(args);
        if (!c) return [watched.size ? `Watching: ${[...watched].join(" ")}` : "Watching nothing. /watch <CALL>"];
        watched.add(c);
        rebuild();
        return [`Watching ${c}.`];
      },
      unwatch: (args) => {
        const c = callOf(args);
        watched.delete(c);
        hits.delete(c);
        rebuild();
        return [`Unwatched ${c}.`];
      }
    }
  });
  tool.on("on_frame", (p) => {
    const hit = match(callOf(p.peerCall));
    if (!hit) return;
    hits.set(hit, Date.now());
    rebuild();
  });
  rebuild();
})();
