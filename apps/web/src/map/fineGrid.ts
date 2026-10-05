// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The graticule's close-up grid follows the view: each time the map settles, and each time a style loads, the
 * lines for what is on screen replace the last ones. Only a style that has the close-up source (the graticule
 * and the Phosphor map) takes them; the online basemap has none and is left alone.
 */
import { useEffect } from "react";
import type * as maplibregl from "maplibre-gl";
import { FINE_GRID_SOURCE, fineGridLines } from "../offlineBasemap.js";

export function useFineGrid(map: maplibregl.Map | null): void {
  useEffect(() => {
    if (!map) return;
    const draw = () => {
      const src = map.getSource(FINE_GRID_SOURCE) as maplibregl.GeoJSONSource | undefined;
      if (!src) return;
      const b = map.getBounds();
      src.setData(
        fineGridLines(
          { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() },
          map.getZoom(),
        ),
      );
    };
    draw();
    map.on("moveend", draw);
    map.on("style.load", draw);
    return () => {
      map.off("moveend", draw);
      map.off("style.load", draw);
    };
  }, [map]);
}
