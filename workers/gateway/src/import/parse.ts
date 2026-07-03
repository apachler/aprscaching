// SPDX-License-Identifier: AGPL-3.0-or-later
/** Format parsers for the importers (M3). Pure + unit-tested with fixtures (live fetch is in sources.ts). */

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
export interface GeoFeature {
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
export interface GpxWpt {
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
