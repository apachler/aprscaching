// SPDX-License-Identifier: MIT
// Away note 1.1.0, built by scripts/build.mjs from tools/away-note/src, lib/ and the
// aprscaching libraries lib.lock pins. Edit the sources, not this file.
(() => {
  // tools/away-note/src/index.js
  var MAX_NOTES = 20;
  var notes = [];
  var away = false;
  var awayMsg = "";
  var message = () => awayMsg || "Operator is away.";
  function rebuild() {
    tool.setPanel({
      title: "Away note",
      nodes: [
        { kind: "badge", text: away ? "AWAY" : "here", tone: away ? "warn" : "ok" },
        ...notes.slice(-8).map((n) => ({ kind: "text", text: n })),
        ...notes.length ? [] : [{ kind: "text", text: "No notes.", tone: "muted" }]
      ]
    });
  }
  tool.on("on_connect", (p) => {
    if (away) p.reply?.(`${message()} Leave a note with:  NOTE <text>`);
  });
  register({
    commands: {
      note: {
        remote: true,
        run: (args) => {
          const t = args.trim();
          if (!t) return ["Usage: NOTE <text>"];
          notes.push(t.slice(0, 120));
          if (notes.length > MAX_NOTES) notes.shift();
          rebuild();
          return ["Note saved - 73!"];
        }
      },
      away: {
        run: (args) => {
          const a = args.trim();
          if (a.toLowerCase() === "off") {
            away = false;
            rebuild();
            return ["Away off."];
          }
          away = true;
          if (a) awayMsg = a.slice(0, 160);
          rebuild();
          return [`Away on: "${message()}"`];
        }
      },
      notes: () => notes.length ? [...notes] : ["No notes."]
    }
  });
  rebuild();
})();
