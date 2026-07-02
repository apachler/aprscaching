// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import type maplibregl from "maplibre-gl";
import { notePrefChange, PREFS_EVENT } from "../prefs.js";

/**
 * Basemap layer switcher: Vector (default) · Topo · Satellite. Raster is OPT-IN per
 * css.md — vector is the default and raster tiles load only when the operator picks them. Both
 * defaults are keyless and free: Topo = OpenTopoMap, Satellite = EOX Sentinel-2 cloudless (CC-BY).
 * A licensed high-res provider (MapTiler / Mapbox / Esri) can be dropped in via VITE_SAT_TILES +
 * VITE_SAT_ATTRIBUTION. Both raster layers are inserted *below* the data overlays (markers are DOM,
 * always on top) and toggled by visibility, so switching is instant and never re-creates the style.
 * The choice is remembered across sessions.
 */
type Base = "vector" | "topo" | "satellite";

const TOPO_TILES = [
  "https://a.tile.opentopomap.org/{z}/{x}/{y}.png",
  "https://b.tile.opentopomap.org/{z}/{x}/{y}.png",
  "https://c.tile.opentopomap.org/{z}/{x}/{y}.png",
];
const TOPO_ATTR = "© OpenTopoMap (CC-BY-SA) · © OpenStreetMap contributors";
// EOX Sentinel-2 cloudless — keyless, free, CC-BY 4.0 (~10 m global mosaic). Override with a licensed
// high-res provider (MapTiler / Mapbox / Esri) via VITE_SAT_TILES + VITE_SAT_ATTRIBUTION for prod.
const SAT_TILES = (import.meta.env.VITE_SAT_TILES as string | undefined)
  ?? "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/{z}/{y}/{x}.jpg";
const SAT_ATTR = (import.meta.env.VITE_SAT_ATTRIBUTION as string | undefined)
  ?? "Sentinel-2 cloudless · © EOX IT Services GmbH (CC-BY-4.0) · contains modified Copernicus Sentinel data";

/** Insert the two raster basemap layers once, beneath any data overlay (mt-* / spots / caches). */
function ensureRaster(m: maplibregl.Map) {
  if (!m.getSource("bm-topo")) m.addSource("bm-topo", { type: "raster", tiles: TOPO_TILES, tileSize: 256, maxzoom: 17, attribution: TOPO_ATTR });
  if (!m.getSource("bm-sat")) m.addSource("bm-sat", { type: "raster", tiles: [SAT_TILES], tileSize: 256, maxzoom: 16, attribution: SAT_ATTR });
  // keep raster under our overlays — find the first overlay layer to insert before, else append on top
  const overlay = m.getStyle().layers?.find((l) => /^(mt-|spots|cache)/.test(l.id))?.id;
  if (!m.getLayer("bm-topo-l")) m.addLayer({ id: "bm-topo-l", type: "raster", source: "bm-topo", layout: { visibility: "none" } }, overlay);
  if (!m.getLayer("bm-sat-l")) m.addLayer({ id: "bm-sat-l", type: "raster", source: "bm-sat", layout: { visibility: "none" } }, overlay);
}

export function BasemapSwitcher(props: { map: maplibregl.Map | null }) {
  const [base, setBase] = useState<Base>(() => {
    try { return (localStorage.getItem("acs.basemap") as Base) || "vector"; } catch { return "vector"; }
  });

  // Re-read when an account sign-in pulls prefs and rewrites acs.basemap (multi-device sync).
  useEffect(() => {
    const onSync = () => { try { setBase((localStorage.getItem("acs.basemap") as Base) || "vector"); } catch { /* ignore */ } };
    window.addEventListener(PREFS_EVENT, onSync);
    return () => window.removeEventListener(PREFS_EVENT, onSync);
  }, []);

  useEffect(() => {
    const m = props.map; if (!m) return;
    const apply = () => {
      if (!m.isStyleLoaded()) return;
      ensureRaster(m);
      m.setLayoutProperty("bm-topo-l", "visibility", base === "topo" ? "visible" : "none");
      m.setLayoutProperty("bm-sat-l", "visibility", base === "satellite" ? "visible" : "none");
    };
    if (m.isStyleLoaded()) apply(); else m.once("load", apply);
    try { localStorage.setItem("acs.basemap", base); } catch { /* private mode */ }
  }, [props.map, base]);

  if (!props.map) return null;
  const opts: { key: Base; label: string; title: string }[] = [
    { key: "vector", label: "Map", title: "Vector basemap (default)" },
    { key: "topo", label: "Topo", title: "OpenTopoMap relief" },
    { key: "satellite", label: "Sat", title: "Satellite imagery" },
  ];
  return (
    <div className="basemap-switch" role="radiogroup" aria-label="Basemap">
      {opts.map((o) => (
        <button key={o.key} role="radio" aria-checked={base === o.key} title={o.title}
                className={base === o.key ? "on" : ""} onClick={() => { setBase(o.key); notePrefChange(); }}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
