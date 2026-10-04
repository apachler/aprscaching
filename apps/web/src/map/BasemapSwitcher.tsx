// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import type * as maplibregl from "maplibre-gl";
import { notePrefChange, PREFS_EVENT } from "../prefs.js";
import { Segmented } from "../ui/index.js";
import { whenStyleReady } from "./mapPaint.js";

/**
 * Basemap layer switcher: Vector (default) · Topo · Satellite. Raster is OPT-IN per
 * css.md — vector is the default and raster tiles load only when the operator picks them. Both
 * defaults are keyless: Topo = OpenTopoMap, Satellite = EOxCloudless (EOX), free for non-commercial use.
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
// OpenTopoMap's required wording: OSM data, SRTM elevation, and its own style
const TOPO_ATTR =
  'Map data: © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Map style: © <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)';
// EOxCloudless, the 2016 layer. EOX licenses it free for non-commercial use (CC BY-NC-SA 4.0) and sells a
// licence for commercial use; the attribution is EOX's own wording, year-matched to the layer. An instance
// with another provider overrides both via VITE_SAT_TILES + VITE_SAT_ATTRIBUTION.
const SAT_TILES =
  (import.meta.env.VITE_SAT_TILES as string | undefined) ??
  "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg";
const SAT_ATTR =
  (import.meta.env.VITE_SAT_ATTRIBUTION as string | undefined) ??
  'EOxCloudless <a href="https://cloudless.eox.at">https://cloudless.eox.at</a> by <a href="https://eox.at">EOX IT Services GmbH</a> (Contains modified Copernicus Sentinel data 2016)';

/** Insert the two raster basemap layers once, beneath any data overlay (mt-* / spots / caches). */
function ensureRaster(m: maplibregl.Map) {
  if (!m.getSource("bm-topo"))
    m.addSource("bm-topo", { type: "raster", tiles: TOPO_TILES, tileSize: 256, maxzoom: 17, attribution: TOPO_ATTR });
  if (!m.getSource("bm-sat"))
    m.addSource("bm-sat", { type: "raster", tiles: [SAT_TILES], tileSize: 256, maxzoom: 16, attribution: SAT_ATTR });
  // keep raster under our overlays — find the first overlay layer to insert before, else append on top
  const overlay = m.getStyle().layers?.find((l) => /^(mt-|spots|cache)/.test(l.id))?.id;
  if (!m.getLayer("bm-topo-l"))
    m.addLayer({ id: "bm-topo-l", type: "raster", source: "bm-topo", layout: { visibility: "none" } }, overlay);
  if (!m.getLayer("bm-sat-l"))
    m.addLayer({ id: "bm-sat-l", type: "raster", source: "bm-sat", layout: { visibility: "none" } }, overlay);
}

export function BasemapSwitcher(props: { map: maplibregl.Map | null; styleEpoch?: number }) {
  const [base, setBase] = useState<Base>(() => {
    try {
      return (localStorage.getItem("acs.basemap") as Base) || "vector";
    } catch {
      return "vector";
    }
  });

  // Re-read when an account sign-in pulls prefs and rewrites acs.basemap (multi-device sync).
  useEffect(() => {
    const onSync = () => {
      try {
        setBase((localStorage.getItem("acs.basemap") as Base) || "vector");
      } catch {
        /* ignore */
      }
    };
    window.addEventListener(PREFS_EVENT, onSync);
    return () => window.removeEventListener(PREFS_EVENT, onSync);
  }, []);

  useEffect(() => {
    const m = props.map;
    if (!m) return;
    const apply = () => {
      if (!m.isStyleLoaded()) return;
      ensureRaster(m);
      m.setLayoutProperty("bm-topo-l", "visibility", base === "topo" ? "visible" : "none");
      m.setLayoutProperty("bm-sat-l", "visibility", base === "satellite" ? "visible" : "none");
    };
    const cancel = whenStyleReady(m, apply);
    try {
      localStorage.setItem("acs.basemap", base);
    } catch {
      /* private mode */
    }
    // Deregister the one-shot load handler so toggling while the style is unloaded doesn't
    // restack listeners. Re-runs on styleEpoch (theme setStyle) → ensureRaster re-adds the wiped layers.
    return () => {
      cancel();
    };
  }, [props.map, base, props.styleEpoch]);

  if (!props.map) return null;
  const opts: { key: Base; label: string; title: string }[] = [
    { key: "vector", label: "Map", title: "Vector basemap (default)" },
    { key: "topo", label: "Topo", title: "OpenTopoMap relief" },
    { key: "satellite", label: "Sat", title: "Satellite imagery" },
  ];
  return (
    <Segmented
      label="Basemap"
      look="overlay"
      value={base}
      onChange={(v) => {
        setBase(v);
        notePrefChange();
      }}
      options={opts.map((o) => ({ value: o.key, label: o.label, title: o.title }))}
    />
  );
}
