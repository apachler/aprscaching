// SPDX-License-Identifier: MIT
// 7PLUS reassembler 1.0.1, built by scripts/build.mjs from tools/sevenplus/src, lib/ and the
// aprscaching libraries lib.lock pins. Edit the sources, not this file.
(() => {
  // lib/sevenplus.js
  var HEADER = /go_7\+\.?[ \t]+(\d{1,3})[ \t]+of[ \t]+(\d{1,3})(?:[ \t]+([\w.-]{1,64}))?/gi;
  var PART = /part[ \t]+(\d{1,3})[ \t]+of[ \t]+(\d{1,3})/gi;
  function decode7plus(input) {
    const text = String(input);
    const lines = text.split(/\r?\n/);
    const starts = lines.filter((l) => /go_7\+/i.test(l)).length;
    const stops = lines.filter((l) => /stop_7\+/i.test(l)).length;
    if (starts === 0) return "No 7plus block found — expected a 'go_7+.' header line.";
    const parts = /* @__PURE__ */ new Set();
    let total = 0;
    let named = null;
    for (const m of [...text.matchAll(HEADER), ...text.matchAll(PART)]) {
      const n = Number(m[1]);
      const of = Number(m[2]);
      if (n < 1 || of < 1 || n > of) continue;
      parts.add(n);
      total = Math.max(total, of);
      named ??= m[3] ?? null;
    }
    const file = named ?? fileNameBefore(text, /go_7\+/gi) ?? fileNameBefore(text, /part\s+\d/gi);
    const body = lines.filter((l) => l.trim() && !/go_7\+|stop_7\+|part\s+\d+\s+of/i.test(l));
    const missing = [];
    for (let i = 1; i <= total; i++) if (!parts.has(i)) missing.push(i);
    const closed = stops >= starts;
    const complete = closed && missing.length === 0;
    return [
      `7plus block — ${starts} start / ${stops} stop marker(s)`,
      total ? `part(s) ${[...parts].sort((a, b) => a - b).join(", ")} of ${total}` : "single part",
      `file: ${file ?? "(unknown)"}`,
      `${body.length} encoded lines (${body.join("").length} chars)`,
      complete ? "status: complete" : missing.length ? `status: incomplete — missing part(s) ${missing.join(", ")}` : "status: incomplete — a part has no stop_7+ line"
    ].join("\n");
  }
  var isWord = (c) => c !== void 0 && /\w/.test(c);
  var isSpace = (c) => c !== void 0 && /\s/.test(c);
  function fileNameBefore(input, marker) {
    for (const m of input.matchAll(marker)) {
      let i = m.index;
      const spaceEnd = i;
      while (isSpace(input[i - 1])) i--;
      if (i === spaceEnd) continue;
      const extEnd = i;
      while (isWord(input[i - 1])) i--;
      const extLen = extEnd - i;
      if (extLen < 1 || extLen > 4 || input[i - 1] !== ".") continue;
      const nameEnd = i - 1;
      i = nameEnd;
      while (isWord(input[i - 1]) || input[i - 1] === "-") i--;
      if (i === nameEnd) continue;
      return input.slice(i, extEnd);
    }
    return null;
  }

  // tools/sevenplus/src/index.js
  register({
    decoders: [
      {
        id: "7plus",
        label: "7PLUS",
        kind: "7plus",
        decode: decode7plus,
        placeholder: "paste the 7PLUS part(s), from go_7+. to stop_7+"
      }
    ]
  });
})();
