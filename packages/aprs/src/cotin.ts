// SPDX-License-Identifier: MIT
/**
 * cotin.ts — inbound Cursor-on-Target: parse a TAK <event> XML into a position fix so CoT senders
 * (ATAK/WinTAK) can be ingested alongside APRS. Pure, regex-based (no XML dep); the gateway's
 * cot.ts handles the outbound direction.
 */
export interface CotFix {
  callsign: string;
  lat: number;
  lon: number;
  altitudeM?: number;
  course?: number;
  speedKn?: number;
  comment?: string;
}

const attr = (s: string, tag: string, name: string): string | undefined => {
  const m = new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]*)"`, "i").exec(s);
  return m ? m[1] : undefined;
};
const unesc = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
const MS_TO_KN = 1 / 0.514444;

/** Parse one CoT <event>. null if it carries no usable point. */
export function parseCot(xml: string): CotFix | null {
  const lat = Number(attr(xml, "point", "lat"));
  const lon = Number(attr(xml, "point", "lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;

  const callsign = (
    attr(xml, "contact", "callsign") ??
    attr(xml, "event", "uid")?.replace(/^APRS\./, "") ??
    "CoT"
  ).toUpperCase();

  const fix: CotFix = { callsign, lat, lon };
  const hae = Number(attr(xml, "point", "hae"));
  if (Number.isFinite(hae) && Math.abs(hae) < 1e6) fix.altitudeM = Math.round(hae);
  const course = Number(attr(xml, "track", "course"));
  if (Number.isFinite(course)) fix.course = Math.round(course);
  const speed = Number(attr(xml, "track", "speed"));
  if (Number.isFinite(speed) && speed > 0) fix.speedKn = Math.round(speed * MS_TO_KN);
  const rem = /<remarks[^>]*>([\s\S]*?)<\/remarks>/i.exec(xml);
  if (rem && rem[1]!.trim()) fix.comment = unesc(rem[1]!.trim());
  return fix;
}

/** Split a possibly-multi-event CoT document/stream into individual <event>…</event> chunks. */
export function splitCotEvents(doc: string): string[] {
  return doc.match(/<event\b[\s\S]*?<\/event>/gi) ?? [];
}
