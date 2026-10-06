// SPDX-License-Identifier: MIT
// Link ping (RTT) 1.0.0, built by scripts/build.mjs from tools/link-ping/src, lib/ and the
// aprscaching libraries lib.lock pins. Edit the sources, not this file.
(() => {
  // tools/link-ping/src/index.js
  var KEPT = 50;
  var samples = [];
  function rebuild() {
    const last = samples.at(-1);
    const avg = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
    tool.setPanel({
      title: "Link ping",
      nodes: samples.length ? [
        { kind: "kv", key: "Last", value: `${last} ms` },
        { kind: "kv", key: "Avg", value: `${avg.toFixed(0)} ms` },
        { kind: "kv", key: "Samples", value: String(samples.length) }
      ] : [{ kind: "text", text: "No samples - /ping or feed link.rtt.", tone: "muted" }]
    });
  }
  tool.subscribe("link.rtt", (data) => {
    const ms = Number(data?.ms);
    if (!isFinite(ms) || ms < 0) return;
    samples.push(ms);
    if (samples.length > KEPT) samples.shift();
    rebuild();
  });
  register({
    commands: {
      ping: () => {
        tool.emit("link.ping.request", {});
        return ["Ping requested (the terminal times the round-trip)."];
      }
    }
  });
  rebuild();
})();
