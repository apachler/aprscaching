// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { StyleSpecification } from "maplibre-gl";
export interface MapHandlers {
  /** The style finished loading for the first time. */
  onLoad: (m: maplibregl.Map) => void;
  /** The view settled after a pan/zoom. */
  onMoveEnd: (m: maplibregl.Map) => void;
  onClick: (m: maplibregl.Map, e: maplibregl.MapMouseEvent) => void;
  /** The viewer's own fix, once they ask the map to locate them. */
  onGeolocate: (lat: number, lon: number) => void;
}

/**
 * Create the MapLibre map once its container node mounts, and remove it on unmount. The container is
 * a callback-ref node rather than a plain ref, so the map initialises exactly when the container
 * exists: an effect keyed on a boolean would run while it is still absent and never re-run, leaving a
 * blank map. Returns the map as state (null until created) and a ref for event handlers. Handlers
 * are read through a ref, so passing fresh closures does not re-create the map.
 */
export function useMapInstance(
  node: HTMLElement | null,
  opts: { style: () => string | StyleSpecification; center: [number, number]; zoom: number },
  handlers: MapHandlers,
): { map: maplibregl.Map | null; mapRef: React.RefObject<maplibregl.Map | null> } {
  const [map, setMap] = useState<maplibregl.Map | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const h = useRef(handlers);
  useEffect(() => {
    h.current = handlers;
  });
  const init = useRef(opts);

  useEffect(() => {
    if (!node || mapRef.current) return;
    const m = new maplibregl.Map({
      container: node,
      style: init.current.style(),
      center: init.current.center,
      zoom: init.current.zoom,
      hash: true,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
    const locate = new maplibregl.GeolocateControl({ trackUserLocation: true });
    locate.on("geolocate", (e) => h.current.onGeolocate(e.coords.latitude, e.coords.longitude));
    m.addControl(locate, "top-left");
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

  return { map, mapRef };
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
