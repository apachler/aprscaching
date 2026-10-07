// SPDX-License-Identifier: MIT
// Auto-status 1.1.1, built by scripts/build.mjs from tools/auto-status/src, lib/ and the
// aprscaching libraries lib.lock pins. Edit the sources, not this file.
(() => {
  // tools/auto-status/src/index.js
  var MIN_MINUTES = 10;
  var STATUS_MAX = 62;
  var everyMin = 0;
  var text = "APRScaching";
  var ticks = 0;
  register({
    commands: {
      autostatus: (args) => {
        const parts = args.trim().split(/\s+/);
        if (parts[0].toLowerCase() === "off") {
          everyMin = 0;
          return ["Auto-status off."];
        }
        const minutes = Number(parts[0]);
        if (!parts[0] || !Number.isFinite(minutes)) return ["Usage: /autostatus <minutes> <text>  |  /autostatus off"];
        everyMin = Math.max(MIN_MINUTES, Math.round(minutes));
        text = (parts.slice(1).join(" ") || "APRScaching").slice(0, STATUS_MAX);
        ticks = 0;
        return [`Auto-status every ${everyMin} min: "${text}" (TX-gated).`];
      }
    }
  });
  tool.on("on_tick", async () => {
    if (everyMin <= 0) return;
    ticks++;
    if (ticks < everyMin) return;
    ticks = 0;
    const sent = await tool.requestTx(`>${text}`);
    tool.log(sent ? "auto-status sent" : "auto-status held (TX gate closed)");
  });
})();
