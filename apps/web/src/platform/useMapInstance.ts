// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { StyleSpecification } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { canDrawMap } from "./mapSupport.js";

// MapLibre locates its worker next to its own module by default, but the bundle has no such file: the
// worker (which parses tiles, GeoJSON and styles off the main thread) is built as its own asset here.
// Without it the style never finishes loading, so the map shows no basemap and never fires "load".
maplibregl.setWorkerUrl(workerUrl);

export interface MapHandlers {
  /** The style finished loading for the first time. */
  onLoad: (m: maplibregl.Map) => void;
  /** The view settled after a pan/zoom. */
  onMoveEnd: (m: maplibregl.Map) => void;
  onClick: (m: maplibregl.Map, e: maplibregl.MapMouseEvent) => void;
}

/**
 * Create the MapLibre map once its container node mounts, and remove it on unmount. The container is
 * a callback-ref node rather than a plain ref, so the map initialises exactly when the container
 * exists: an effect keyed on a boolean would run while it is still absent and never re-run, leaving a
 * blank map. Returns the map as state (null until created), a ref for event handlers, and whether
 * the browser cannot draw a map at all (no WebGL2). Handlers are read through a ref, so passing fresh
 * closures does not re-create the map.
 */
export function useMapInstance(
  node: HTMLElement | null,
  opts: {
    style: () => string | StyleSpecification;
    /** The style to fall back to when `style` cannot load (no connection to the tile service). */
    fallbackStyle?: () => StyleSpecification;
    center: [number, number];
    zoom: number;
  },
  handlers: MapHandlers,
): { map: maplibregl.Map | null; mapRef: React.RefObject<maplibregl.Map | null>; mapFailed: boolean } {
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  // the browser refused the WebGL2 context the map draws with: the app goes on without a map
  const [mapFailed, setMapFailed] = useState(false);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const h = useRef(handlers);
  useEffect(() => {
    h.current = handlers;
  });
  const init = useRef(opts);

  useEffect(() => {
    if (!node || mapRef.current) return;
    if (!canDrawMap()) {
      setMapFailed(true);
      return;
    }
    let m: maplibregl.Map;
    try {
      m = new maplibregl.Map({
        container: node,
        style: init.current.style(),
        center: init.current.center,
        zoom: init.current.zoom,
        hash: true,
        attributionControl: false,
      });
    } catch (e) {
      console.error(e);
      setMapFailed(true);
      return;
    }
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    // The attribution joins the top-left stack: the bottom corners carry the app's own overlays (the
    // coordinate readout, the map tools), which would cover it.
    m.addControl(new maplibregl.AttributionControl({ compact: true }), "top-left");
    // the canvas takes MapLibre's keyboard handler (arrows pan, + and − zoom) once it has focus; say so
    m.getCanvas().setAttribute("aria-label", "Map. Arrow keys pan; plus and minus zoom; Nearby lists every cache.");
    // the locate button joins this stack from LocateControl, driven by the app's own location helper
    // A remote style that cannot load (offline, or the tile service down) never fires "load", so the
    // map would show nothing and load no caches: switch to the self-contained fallback once.
    // A failed tile while the style is still loading is not the style failing, so it takes the style's own
    // URL failing, or no connection at all.
    let fellBack = false;
    const styleUrl = (() => {
      const st = init.current.style();
      return typeof st === "string" ? st.split("?")[0] : null;
    })();
    m.on("error", (e) => {
      if (fellBack || !styleUrl || m.isStyleLoaded() || !init.current.fallbackStyle) return;
      const failed = (e.error as { url?: string } | undefined)?.url?.split("?")[0];
      if (failed !== styleUrl && navigator.onLine) return;
      fellBack = true;
      m.setStyle(init.current.fallbackStyle());
    });
    m.on("load", () => h.current.onLoad(m));
    m.on("moveend", () => h.current.onMoveEnd(m));
    m.on("click", (e) => h.current.onClick(m, e));
    mapRef.current = m;
    setMap(m);
    return () => {
      m.remove();
      mapRef.current = null;
      setMap(null);
    };
  }, [node]);

  return { map, mapRef, mapFailed };
}

/** The map's `#zoom/lat/lon[/bearing[/pitch]]` in MapLibre's own hash format. */
export function mapHash(m: maplibregl.Map): string {
  const center = m.getCenter();
  const zoom = Math.round(m.getZoom() * 100) / 100;
  // the coordinate precision MapLibre uses: enough decimals to place the centre within half a pixel
  const precision = Math.ceil((zoom * Math.LN2 + Math.log(512 / 360 / 0.5)) / Math.LN10);
  const f = Math.pow(10, precision);
  const bearing = m.getBearing();
  const pitch = m.getPitch();
  let hash = `#${zoom}/${Math.round(center.lat * f) / f}/${Math.round(center.lng * f) / f}`;
  if (bearing || pitch) hash += `/${Math.round(bearing * 10) / 10}`;
  if (pitch) hash += `/${Math.round(pitch)}`;
  return hash;
}
