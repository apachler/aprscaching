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
  const filem = input.match(/([\w-]+\.[\w]{1,4})\s+go_7\+/i) ?? input.match(/([\w-]+\.[\w]{1,4})\s+part\s+\d+/i);
  const body = lines.filter((l) => l.trim() && !/go_7\+|stop_7\+|part\s+\d+\s+of/i.test(l));
  const complete = starts > 0 && stops > 0 && (!partm || partm[1] === partm[2]);

  return [
    `7plus block — ${starts} start / ${stops} stop marker(s)`,
    partm ? `part ${partm[1]} of ${partm[2]}` : "single part",
    `file: ${filem ? filem[1] : "(unknown)"}`,
    `${body.length} encoded lines (${body.join("").length} chars)`,
    complete ? "status: complete" : "status: incomplete — collect the remaining parts",
  ].join("\n");
}
