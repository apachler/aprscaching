// SPDX-License-Identifier: MIT
// Connect bell 1.0.0, built by scripts/build.mjs from tools/connect-bell/src, lib/ and the
// aprscaching libraries lib.lock pins. Edit the sources, not this file.
(() => {
  // lib/text.js
  function ago(ms, now = Date.now()) {
    const s = Math.max(0, Math.floor((now - ms) / 1e3));
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
  }

  // tools/connect-bell/src/index.js
  tool.on("on_connect", (p) => {
    const who = p.peerCall ? String(p.peerCall) : "a station";
    tool.log(`*ring* ${who} connected`);
    tool.setPanel({
      title: "Connect bell",
      nodes: [{ kind: "kv", key: "Last connect", value: `${who} (${ago(Date.now())} ago)` }]
    });
  });
  tool.setPanel({
    title: "Connect bell",
    nodes: [{ kind: "text", text: "Waiting for a connect...", tone: "muted" }]
  });
})();
