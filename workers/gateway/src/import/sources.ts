// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Import source adapters (M3). Each loads a third-party dataset and normalizes it to ImportedCache.
 * Bulk/keyless ham programs (SOTA/POTA/WWFF/WWBOTA), the keyed OpenCaching OKAPI, Geocaching
 * Australia GPX, and a generic GeoJSON adapter (covers WCA via CQGMA, and future OSM/Wikidata).
 *
 * Live fetch only works where outbound egress is open (deploy / ingest box). Parsers (parse.ts)
 * are unit-tested with fixtures; this module is the thin fetch+map layer.
 */
import type { Env } from "../env.js";
import type { CacheType } from "@aprsweb/shared";
import { parseCsv, parseGeoJsonFeatures, parseGpxWaypoints } from "./parse.js";

export interface ImportedCache {
  source: string; externalId: string; code: string; type: CacheType;
  title: string; lat: number; lon: number;
  sourceName: string; sourceUrl: string; ownerCall?: string; description?: string;
}

export interface ImportScope {
  region?: string;                                    // SOTA "GM/SI" · POTA "US-NY" · WWFF "DLFF" · GCAU "vic"
  bbox?: [number, number, number, number];            // WWBOTA / OpenCaching (minLon,minLat,maxLon,maxLat)
  url?: string;                                        // generic GeoJSON URL / OKAPI base override
  key?: string;                                        // OKAPI per-node consumer key override (multi-node)
  limit?: number;                                      // Wikidata result cap
  // generic geojson knobs:
  source?: string; type?: CacheType; sourceName?: string; deepLink?: string; // deepLink may contain {ref}
}

export interface SourceAdapter {
  id: string; sourceName: string;
  load(env: Env, scope: ImportScope): Promise<ImportedCache[]>;
}

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { headers: { "user-agent": "aprscaching-importer/0.1 (+https://aprscaching.com)" } });
  if (!r.ok) throw new Error(`fetch ${r.status} ${url}`);
  return r.text();
}
const num = (v: unknown) => Number(String(v));
function mapGeocacheType(t: string | undefined): CacheType {
  const s = (t ?? "").toLowerCase();
  if (s.includes("multi")) return "multi";
  if (s.includes("mystery") || s.includes("quiz") || s.includes("puzzle")) return "multi";
  return "traditional";
}

export const SOURCES: Record<string, SourceAdapter> = {
  // ---- SOTA: region JSON (bounded, has coords) ----
  sota: {
    id: "sota", sourceName: "SOTA",
    async load(_env, scope) {
      const region = (scope.region ?? "").trim();
      if (!region.includes("/")) throw new Error("sota: scope.region required like 'GM/SI'");
      const [assoc, reg] = region.split("/");
      const data = JSON.parse(await fetchText(`https://api-db2.sota.org.uk/api/regions/${encodeURIComponent(assoc!)}/${encodeURIComponent(reg!)}`));
      const summits: any[] = data?.summits ?? [];
      return summits.filter((s) => s.latitude != null && s.longitude != null).map((s) => ({
        source: "sota", externalId: String(s.summitCode), code: String(s.summitCode), type: "sota" as CacheType,
        title: s.name || s.summitCode, lat: num(s.latitude), lon: num(s.longitude),
        sourceName: "SOTA", sourceUrl: `https://sotl.as/summits/${s.summitCode}`, ownerCall: "SOTA",
        description: s.points != null ? `${s.altM ?? s.altitude ?? "?"} m · ${s.points} pts` : undefined,
      }));
    },
  },

  // ---- POTA: nightly bulk CSV, filtered by location ----
  pota: {
    id: "pota", sourceName: "POTA",
    async load(_env, scope) {
      const region = (scope.region ?? "").toUpperCase().trim();
      const { rows } = parseCsv(await fetchText("https://pota.app/all_parks_ext.csv"));
      return rows.filter((r) => r.latitude && r.longitude && (!region || (r.locationDesc ?? "").toUpperCase().split(",").includes(region)))
        .map((r) => ({
          source: "pota", externalId: r.reference ?? "", code: r.reference ?? "", type: "pota" as CacheType,
          title: r.name || r.reference || "", lat: num(r.latitude), lon: num(r.longitude),
          sourceName: "POTA", sourceUrl: `https://pota.app/#/park/${r.reference ?? ""}`, ownerCall: "POTA",
          description: r.locationName || r.locationDesc || undefined,
        }));
    },
  },

  // ---- WWFF: bulk CSV, filtered by program prefix ----
  wwff: {
    id: "wwff", sourceName: "WWFF",
    async load(_env, scope) {
      const program = (scope.region ?? "").toUpperCase().trim();
      const { rows } = parseCsv(await fetchText("https://wwff.co/wwff-data/wwff_directory.csv"));
      return rows.filter((r) => r.latitude && r.longitude && (r.status ?? "").toLowerCase() !== "deleted" && (!program || (r.reference ?? "").toUpperCase().startsWith(program)))
        .map((r) => ({
          source: "wwff", externalId: r.reference ?? "", code: r.reference ?? "", type: "wwff" as CacheType,
          title: r.name || r.reference || "", lat: num(r.latitude), lon: num(r.longitude),
          sourceName: "WWFF", sourceUrl: r.website || `https://wwff.co/directory/`, ownerCall: "WWFF",
        }));
    },
  },

  // ---- WWBOTA/UKBOTA bunkers: live GeoJSON by bbox ----
  bunker: {
    id: "bunker", sourceName: "WWBOTA",
    async load(_env, scope) {
      if (!scope.bbox) throw new Error("bunker: scope.bbox required [minLon,minLat,maxLon,maxLat]");
      const [w, s, e, n] = scope.bbox;
      const feats = parseGeoJsonFeatures(await fetchText(`https://api.wwbota.org/bunkers/?format=GEOJSON&bbox=${w},${s},${e},${n}`));
      return feats.map((f) => {
        const ref = String(f.props.reference ?? f.props.ref ?? "");
        return { source: "bunker", externalId: ref, code: ref, type: "bunker" as CacheType,
          title: String(f.props.name ?? ref), lat: f.lat, lon: f.lon,
          sourceName: "WWBOTA", sourceUrl: `https://ukbota.net/atlas/?bunker=${encodeURIComponent(ref)}`, ownerCall: "WWBOTA" };
      }).filter((c) => c.externalId);
    },
  },

  // ---- OpenCaching (OKAPI): bbox search -> geocache details. Needs a per-node consumer key. ----
  opencaching: {
    id: "opencaching", sourceName: "OpenCaching",
    async load(env, scope) {
      // each OpenCaching node has its OWN database + key: import nodes separately (pass url+key per node)
      const base = (scope.url ?? env.OKAPI_BASE ?? "").replace(/\/+$/, "");
      const key = scope.key ?? env.OKAPI_KEY;
      if (!base || !key) throw new Error("opencaching: provide {url,key} (per-node) or set OKAPI_BASE + OKAPI_KEY");
      if (!scope.bbox) throw new Error("opencaching: scope.bbox required");
      const [w, s, e, n] = scope.bbox;
      const search = JSON.parse(await fetchText(`${base}/okapi/services/caches/search/bbox?bbox=${s}|${w}|${n}|${e}&status=Available&limit=500&consumer_key=${key}`));
      const codes: string[] = search?.results ?? [];
      if (!codes.length) return [];
      const detail = JSON.parse(await fetchText(`${base}/okapi/services/caches/geocaches?cache_codes=${codes.slice(0, 500).join("|")}&fields=code|name|location|type|status|url&consumer_key=${key}`));
      const out: ImportedCache[] = [];
      for (const k of Object.keys(detail)) {
        const c = detail[k]; if (!c?.location) continue;
        const lat = num(String(c.location).split("|")[0]), lon = num(String(c.location).split("|")[1]);
        out.push({ source: "opencaching", externalId: c.code ?? k, code: c.code ?? k, type: mapGeocacheType(c.type),
          title: c.name ?? k, lat, lon, sourceName: "OpenCaching", sourceUrl: c.url ?? `${base}/viewcache.php?wp=${c.code ?? k}`, ownerCall: "OC" });
      }
      return out;
    },
  },

  // ---- Geocaching Australia: keyless GPX per state ----
  gcau: {
    id: "gcau", sourceName: "Geocaching Australia",
    async load(_env, scope) {
      const state = (scope.region ?? "").toLowerCase().trim();
      if (!state) throw new Error("gcau: scope.region required (state, e.g. 'vic')");
      const wpts = parseGpxWaypoints(await fetchText(`https://geocaching.com.au/caches/au/${state}.gpx`));
      const out: ImportedCache[] = [];
      for (const w of wpts) {
        const name = w.name; if (!name) continue;
        out.push({ source: "gcau", externalId: name, code: name, type: mapGeocacheType(w.type),
          title: w.urlname || w.desc || name, lat: w.lat, lon: w.lon,
          sourceName: "Geocaching Australia", sourceUrl: w.url || `https://geocaching.com.au/cache/${name}`, ownerCall: "GCAU" });
      }
      return out;
    },
  },

  // ---- IOTA islands: keyless JSON (non-commercial use). Coords used where present. ----
  iota: {
    id: "iota", sourceName: "IOTA",
    async load(_env, scope) {
      const data = JSON.parse(await fetchText("https://www.iota-world.org/islands-on-the-air/downloads/download-file.html?path=fulllist.json"));
      const groups: any[] = Array.isArray(data) ? data : (data?.groups ?? data?.fulllist ?? data?.islands ?? []);
      const prefix = (scope.region ?? "").toUpperCase().trim(); // e.g. "EU"
      const out: ImportedCache[] = [];
      for (const g of groups) {
        const ref = String(g.reference ?? g.iota ?? g.ref ?? "");
        const lat = num(g.latitude ?? g.lat), lon = num(g.longitude ?? g.lon);
        if (!ref || !isFinite(lat) || !isFinite(lon)) continue;          // coords are sometimes omitted
        if (prefix && !ref.toUpperCase().startsWith(prefix)) continue;
        out.push({ source: "iota", externalId: ref, code: ref, type: "traditional",
          title: g.name ?? g.groupName ?? ref, lat, lon, sourceName: "IOTA",
          sourceUrl: `https://www.iota-world.org/iota-groups-islands/groups.html?filter[search]=${encodeURIComponent(ref)}`, ownerCall: "IOTA" });
      }
      return out;
    },
  },

  // ---- OpenStreetMap via Overpass (ODbL): generic POI layer (peaks, castles, lighthouses, mills…) ----
  osm: {
    id: "osm", sourceName: "OpenStreetMap",
    async load(_env, scope) {
      if (!scope.bbox) throw new Error("osm: scope.bbox required");
      const [k, v] = (scope.region ?? "natural=peak").trim().split("="); // e.g. natural=peak, historic=castle, man_made=lighthouse
      const [w, s, e, n] = scope.bbox;
      const ql = `[out:json][timeout:25];node["${k}"${v ? `="${v}"` : ""}](${s},${w},${n},${e});out;`;
      const data = JSON.parse(await fetchText(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(ql)}`));
      const type = (scope.type ?? "traditional") as CacheType;
      return (data?.elements ?? []).filter((el: any) => el.lat != null && el.lon != null && el.tags?.name).map((el: any) => ({
        source: "osm", externalId: `node/${el.id}`, code: `OSM-${el.id}`, type,
        title: el.tags.name, lat: num(el.lat), lon: num(el.lon),
        sourceName: "OpenStreetMap", sourceUrl: `https://www.openstreetmap.org/node/${el.id}`, ownerCall: "OSM",
        description: el.tags.ele ? `${el.tags.ele} m` : undefined,
      }));
    },
  },

  // ---- Wikidata via SPARQL (CC0): items of a given type with coordinates ----
  wikidata: {
    id: "wikidata", sourceName: "Wikidata",
    async load(_env, scope) {
      const qid = (scope.region ?? "Q8502").trim(); // instance-of: Q8502 mountain · Q23413 castle · Q39715 lighthouse
      const limit = Math.min(scope.limit ?? 1000, 5000);
      let box = "";
      if (scope.bbox) {
        const [w, s, e, n] = scope.bbox;
        box = `SERVICE wikibase:box { ?item wdt:P625 ?loc . bd:serviceParam wikibase:cornerSouthWest "Point(${w} ${s})"^^geo:wktLiteral . bd:serviceParam wikibase:cornerNorthEast "Point(${e} ${n})"^^geo:wktLiteral . }`;
      }
      const sparql = `SELECT ?item ?itemLabel ?lat ?lon WHERE { ?item wdt:P31 wd:${qid} . ${box} ?item p:P625/psv:P625 [ wikibase:geoLatitude ?lat ; wikibase:geoLongitude ?lon ] . SERVICE wikibase:label { bd:serviceParam wikibase:language "en" } } LIMIT ${limit}`;
      const data = JSON.parse(await fetchText(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`));
      const type = (scope.type ?? "traditional") as CacheType;
      return (data?.results?.bindings ?? []).map((b: any) => {
        const qurl = b.item?.value ?? ""; const id = qurl.split("/").pop() ?? "";
        return { source: "wikidata", externalId: id, code: id, type,
          title: b.itemLabel?.value ?? id, lat: num(b.lat?.value), lon: num(b.lon?.value),
          sourceName: "Wikidata", sourceUrl: qurl || `https://www.wikidata.org/wiki/${id}`, ownerCall: "Wikidata" };
      }).filter((c: ImportedCache) => c.externalId && isFinite(c.lat) && isFinite(c.lon));
    },
  },

  // ---- Generic GeoJSON: WCA (via CQGMA), or any GeoJSON export ----
  geojson: {
    id: "geojson", sourceName: "GeoJSON",
    async load(_env, scope) {
      if (!scope.url) throw new Error("geojson: scope.url required");
      const sourceName = scope.sourceName ?? "GeoJSON";
      const source = scope.source ?? "geojson";
      const type = (scope.type ?? "traditional") as CacheType;
      return parseGeoJsonFeatures(await fetchText(scope.url)).map((f, i) => {
        const ref = String(f.props.reference ?? f.props.ref ?? f.props.id ?? i);
        const url = String(f.props.url ?? (scope.deepLink ? scope.deepLink.replace("{ref}", encodeURIComponent(ref)) : ""));
        return { source, externalId: ref, code: ref, type, title: String(f.props.name ?? f.props.title ?? ref),
          lat: f.lat, lon: f.lon, sourceName, sourceUrl: url, ownerCall: sourceName };
      });
    },
  },
};
