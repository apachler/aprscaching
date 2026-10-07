// SPDX-License-Identifier: MIT
// Connect bell 1.0.1, built by scripts/build.mjs from tools/connect-bell/src, lib/ and the
// aprscaching libraries lib.lock pins. Edit the sources, not this file.
(() => {
  // lib/text.js
  function utcTime(ms) {
    const d = new Date(ms);
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}Z`;
  }

  // tools/connect-bell/src/index.js
  tool.on("on_connect", (p) => {
    const who = p.peerCall ? String(p.peerCall) : "a station";
    tool.log(`*ring* ${who} connected`);
    tool.setPanel({
      title: "Connect bell",
      nodes: [{ kind: "kv", key: "Last connect", value: `${who} at ${utcTime(Date.now())}` }]
    });
  });
  tool.setPanel({
    title: "Connect bell",
    nodes: [{ kind: "text", text: "Waiting for a connect...", tone: "muted" }]
  });
})();
