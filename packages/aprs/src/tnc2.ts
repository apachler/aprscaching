import type { ParsedFrame } from "./types.js";

/** Parse a TNC2 APRS-IS line: SRC>DST,PATH1,PATH2:payload. null on comment/malformed. */
export function parseTNC2(line: string): ParsedFrame | null {
  const s = line.trimEnd();
  if (!s || s.startsWith("#")) return null;
  const colon = s.indexOf(":");
  if (colon < 0) return null;
  const header = s.slice(0, colon);
  const payload = s.slice(colon + 1);
  const gt = header.indexOf(">");
  if (gt < 0) return null;
  const src = header.slice(0, gt);
  const rest = header.slice(gt + 1).split(",");
  const dst = rest[0] ?? "";
  const path = rest.slice(1);
  return { src, dst, path, payload, raw: s };
}
