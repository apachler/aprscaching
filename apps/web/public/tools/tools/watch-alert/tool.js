// SPDX-License-Identifier: MIT
// Watch & alert 1.1.1, built by scripts/build.mjs from tools/watch-alert/src, lib/ and the
// aprscaching libraries lib.lock pins. Edit the sources, not this file.
(() => {
  // lib/text.js
  function utcTime(ms) {
    const d = new Date(ms);
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}Z`;
  }
  var asStr = (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : "";
  var callOf = (v) => asStr(v).trim().toUpperCase();

  // tools/watch-alert/src/index.js
  var QUIET_MS = 10 * 60 * 1e3;
  var watched = /* @__PURE__ */ new Set();
  var hits = /* @__PURE__ */ new Map();
  var base = (call) => call.split("-")[0];
  var calls = (args) => String(args).split(/[\s,]+/).map(callOf).filter(Boolean);
  var match = (call) => watched.has(call) ? call : watched.has(base(call)) ? base(call) : null;
  function rebuild() {
    const rows = [...watched].map((c) => [c, hits.has(c) ? utcTime(hits.get(c)) : "—"]);
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
        const cs = calls(args);
        if (!cs.length) return [watched.size ? `Watching: ${[...watched].join(" ")}` : "Watching nothing. /watch <CALL>"];
        for (const c of cs) watched.add(c);
        rebuild();
        return [`Watching ${cs.join(" ")}.`];
      },
      unwatch: (args) => {
        const cs = calls(args);
        if (!cs.length) return ["Usage: /unwatch <CALL> [CALL …]"];
        for (const c of cs) {
          watched.delete(c);
          hits.delete(c);
        }
        rebuild();
        return [`Unwatched ${cs.join(" ")}.`];
      }
    }
  });
  tool.on("on_frame", (p) => {
    const hit = match(callOf(p.peerCall));
    if (!hit) return;
    const now = Date.now();
    if (!hits.has(hit) || now - hits.get(hit) >= QUIET_MS) tool.log(`heard ${callOf(p.peerCall)} (watching ${hit})`);
    hits.set(hit, now);
    rebuild();
  });
  rebuild();
})();
