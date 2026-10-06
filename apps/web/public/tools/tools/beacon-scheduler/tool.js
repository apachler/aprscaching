// SPDX-License-Identifier: MIT
// Beacon scheduler 1.1.0, built by scripts/build.mjs from tools/beacon-scheduler/src, lib/ and the
// aprscaching libraries lib.lock pins. Edit the sources, not this file.
(() => {
  // tools/beacon-scheduler/src/index.js
  var MIN_MINUTES = 10;
  var DEFAULT_MINUTES = 30;
  register({
    commands: {
      beacon: async (args) => {
        const [first, ...rest] = args.trim().split(/\s+/);
        if (first?.toLowerCase() === "off") {
          await tool.scheduleBeacon(null);
          return ["Beacon off."];
        }
        const minutes = Math.max(MIN_MINUTES, Math.round(Number(first) || DEFAULT_MINUTES));
        const comment = rest.join(" ") || "APRScaching";
        try {
          await tool.scheduleBeacon({ comment, intervalSec: minutes * 60 });
        } catch (e) {
          return [`Beacon refused: ${e.message}.`];
        }
        return [`Beacon scheduled every ${minutes} min.`];
      }
    }
  });
})();
