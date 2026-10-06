// SPDX-License-Identifier: MIT
// Auto-responder 1.0.0, built by scripts/build.mjs from tools/auto-responder/src, lib/ and the
// aprscaching libraries lib.lock pins. Edit the sources, not this file.
(() => {
  // tools/auto-responder/src/index.js
  tool.on("on_connect", (p) => {
    const who = p.peerCall ? ` ${p.peerCall}` : "";
    const me = p.myCall ? ` ${p.myCall}` : " an APRScaching";
    p.reply?.(`Welcome${who} - this is${me} auto-responder. Type H for help.`);
  });
})();
