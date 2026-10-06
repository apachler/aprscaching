// SPDX-License-Identifier: MIT
// APRS SSID guide 1.0.0, built by scripts/build.mjs from tools/aprs-ssid-guide/src, lib/ and the
// aprscaching libraries lib.lock pins. Edit the sources, not this file.
(() => {
  // tools/aprs-ssid-guide/src/index.js
  tool.setPanel({
    title: "Conventional APRS SSIDs",
    nodes: [
      { kind: "text", text: "Widely-followed conventions (not enforced by APRS-IS).", tone: "muted" },
      {
        kind: "table",
        head: ["SSID", "Typical use"],
        rows: [
          ["-0", "primary / home station"],
          ["-1", "generic / RX-only IGate"],
          ["-5", "phone / other networks (DMR, D-STAR)"],
          ["-7", "handheld / HT"],
          ["-9", "mobile / vehicle"],
          ["-10", "IGate / internet"],
          ["-13", "weather station"],
          ["-15", "generic additional"]
        ]
      }
    ]
  });
})();
