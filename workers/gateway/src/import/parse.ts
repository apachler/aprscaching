// SPDX-License-Identifier: AGPL-3.0-or-later
/** Format parsers for the importers. Pure + unit-tested with fixtures (live fetch is in sources.ts). */
import type { AttributionPart } from "@aprscaching/shared";

// ---------- CSV (RFC-4180-ish: quoted fields, embedded commas/newlines, "" escapes) ----------
function splitCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (c !== "\r") cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function parseCsv(
  text: string,
  opts: { skipLines?: number } = {},
): { header: string[]; rows: Record<string, string>[] } {
  const all = splitCsvRows(text);
  const start = opts.skipLines ?? 0;
  const header = (all[start] ?? []).map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (let i = start + 1; i < all.length; i++) {
    const cells = all[i]!;
    if (cells.length === 1 && cells[0] === "") continue; // blank line
    const row: Record<string, string> = {};
    header.forEach((h, j) => {
      row[h] = (cells[j] ?? "").trim();
    });
    rows.push(row);
  }
  return { header, rows };
}

// ---------- GeoJSON (Point features) ----------
interface GeoFeature {
  lat: number;
  lon: number;
  props: Record<string, unknown>;
}
export function parseGeoJsonFeatures(text: string): GeoFeature[] {
  const fc = JSON.parse(text) as { features?: unknown[] };
  const out: GeoFeature[] = [];
  for (const f of Array.isArray(fc.features) ? fc.features : []) {
    const feat = f as { geometry?: { type?: string; coordinates?: unknown }; properties?: Record<string, unknown> };
    const g = feat.geometry;
    if (g?.type === "Point" && Array.isArray(g.coordinates)) {
      const [lon, lat] = g.coordinates as number[];
      if (typeof lat === "number" && typeof lon === "number") out.push({ lat, lon, props: feat.properties ?? {} });
    }
  }
  return out;
}

// ---------- GPX (<wpt>) ----------
interface GpxWpt {
  lat: number;
  lon: number;
  name?: string;
  desc?: string;
  type?: string;
  urlname?: string;
  url?: string;
}
function xmlText(body: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(body);
  return m?.[1]
    ?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .trim()
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
export function parseGpxWaypoints(xml: string): GpxWpt[] {
  const out: GpxWpt[] = [];
  const re = /<wpt\b([^>]*)>([\s\S]*?)<\/wpt>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const lat = Number(/\blat\s*=\s*"([^"]+)"/.exec(m[1]!)?.[1]);
    const lon = Number(/\blon\s*=\s*"([^"]+)"/.exec(m[1]!)?.[1]);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const body = m[2]!;
    out.push({
      lat,
      lon,
      name: xmlText(body, "name"),
      desc: xmlText(body, "desc"),
      type: xmlText(body, "type"),
      urlname: xmlText(body, "urlname"),
      url: xmlText(body, "url"),
    });
  }
  return out;
}

// ---------- attribution notes (a source's HTML → text runs with optional links) ----------
const ATTRIBUTION_MAX_CHARS = 1000;
const ATTRIBUTION_MAX_PARTS = 24;

const codePoint = (n: number): string => (Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "");
function htmlText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&#(\d+);/g, (_, d: string) => codePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => codePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&copy;/g, "©")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}
function httpUrl(raw: string): string | undefined {
  try {
    const u = new URL(htmlText(raw).trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reduce a source's HTML attribution note (OKAPI's `attribution_note`) to plain text runs, keeping each
 * http(s) link it carries. The cache detail renders the runs as text and anchors, so no markup from the
 * source reaches the page. A note with no text yields an empty list; a long one is cut to a bounded size.
 */
export function htmlToAttribution(html: unknown): AttributionPart[] {
  if (typeof html !== "string" || !html.trim()) return [];
  const runs: AttributionPart[] = [];
  const push = (text: string, href?: string) => {
    if (!text) return;
    const last = runs[runs.length - 1];
    if (last && !last.href && !href) last.text += text;
    else runs.push(href ? { text, href } : { text });
  };
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let at = 0;
  let m: RegExpExecArray | null;
  while ((m = anchor.exec(html))) {
    push(htmlText(html.slice(at, m.index)));
    const attr = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[1]!);
    push(htmlText(m[2]!), attr ? httpUrl(attr[1] ?? attr[2] ?? attr[3] ?? "") : undefined);
    at = m.index + m[0].length;
  }
  push(htmlText(html.slice(at)));
  if (!runs.length) return [];
  runs[0]!.text = runs[0]!.text.trimStart();
  runs[runs.length - 1]!.text = runs[runs.length - 1]!.text.trimEnd();
  const out: AttributionPart[] = [];
  let budget = ATTRIBUTION_MAX_CHARS;
  for (const r of runs) {
    if (!r.text || budget <= 0 || out.length >= ATTRIBUTION_MAX_PARTS) continue;
    const text = r.text.slice(0, budget);
    budget -= text.length;
    out.push(r.href ? { text, href: r.href } : { text });
  }
  return out.some((r) => r.text.trim()) ? out : [];
}
