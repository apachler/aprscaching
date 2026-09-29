// SPDX-License-Identifier: MIT
/**
 * sevenplus.ts — a tolerant 7PLUS parser/reassembler. 7PLUS was the packet-BBS way to
 * shuttle binary files as 7-bit text split across numbered message parts. This decoder recognises the
 * `go_7+.` / `stop_7+` markers + the `part N of M` header, reports the file/part/completeness, and
 * concatenates the encoded bodies so scattered parts can be stitched. Byte-exact reconstruction of the
 * original binary is intentionally left to a follow-on — this is the collect/summarise
 * step that's useful in the browser. Pure + dependency-free.
 */
export function decode7plus(input: string): string {
  const lines = input.split(/\r?\n/);
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
    complete ? "status: complete" : "status: incomplete — collect the remaining parts",
  ].join("\n");
}

const isWord = (c: string | undefined) => c !== undefined && /\w/.test(c);
const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);

/**
 * The first `name.ext` (name of word characters and '-', extension of 1–4 word characters) that is
 * followed by whitespace and then a match of `marker` (a global pattern). Found by walking back from each
 * marker, which stays linear on a crafted line; a single leftmost-match pattern over the whole input
 * would retry the long name run from every start position.
 */
function fileNameBefore(input: string, marker: RegExp): string | null {
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
