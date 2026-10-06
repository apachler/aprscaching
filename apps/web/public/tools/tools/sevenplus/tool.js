// SPDX-License-Identifier: MIT
// 7PLUS reassembler 1.0.0, built by scripts/build.mjs from tools/sevenplus/src, lib/ and the
// aprscaching libraries lib.lock pins. Edit the sources, not this file.
(() => {
  // lib/sevenplus.js
  function decode7plus(input) {
    const lines = String(input).split(/\r?\n/);
    const starts = lines.filter((l) => /go_7\+/i.test(l)).length;
    const stops = lines.filter((l) => /stop_7\+/i.test(l)).length;
    if (starts === 0) return "No 7plus block found — expected a 'go_7+.' header line.";
    const partm = input.match(/part\s+(\d+)\s+of\s+(\d+)/i);
    const file = fileNameBefore(input, /go_7\+/gi) ?? fileNameBefore(input, /part\s+\d/gi);
    const body = lines.filter((l) => l.trim() && !/go_7\+|stop_7\+|part\s+\d+\s+of/i.test(l));
    const complete = starts > 0 && stops > 0 && (!partm || partm[1] === partm[2]);
    return [
      `7plus block — ${starts} start / ${stops} stop marker(s)`,
      partm ? `part ${partm[1]} of ${partm[2]}` : "single part",
      `file: ${file ?? "(unknown)"}`,
      `${body.length} encoded lines (${body.join("").length} chars)`,
      complete ? "status: complete" : "status: incomplete — collect the remaining parts"
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
