// SPDX-License-Identifier: AGPL-3.0-or-later
// maplibre-gl does not declare the ambient GeoJSON namespace; import it explicitly.
import type * as GeoJSON from "geojson";
import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import type { MeshcomLink } from "../api.js";
import { LINKS_VIEWPOINT, MESHMAP_ATTRIBUTION, linkFeatures, meshmapUrl } from "./meshcomView.js";
import { tokenHex, whenStyleReady } from "../map/mapPaint.js";

/**
 * MeshCom links as the operator's own node(s) heard them: a solid line for a direct hearing, a dashed one
 * for each leg of a relay path, wider for a stronger signal, fainter with age. A click on a line names both
 * ends, the kind and the signal. The legend always says whose viewpoint this is.
 */
const SRC = "mc-links";
const LAYERS = ["mc-links-direct", "mc-links-relay"];

/** The layer colour from the theme token, as MapLibre needs it (map/mapPaint.ts). */
const lineColor = (): string => tokenHex("--meshcom", "#b0417f");

export function MeshcomLinks(props: { map: maplibregl.Map | null; links: MeshcomLink[]; styleEpoch: number }) {
  const { map, links, styleEpoch } = props;
  // the lines to draw, for a style that finishes loading after the links arrived
  const data = () => linkFeatures(links, Math.floor(Date.now() / 1000)) as GeoJSON.FeatureCollection;
  const latest = useRef(data);
  latest.current = data;

  useEffect(() => {
    const m = map;
    if (!m) return;
    const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, className: "mc-link-popup" });
    const onClick = (e: maplibregl.MapLayerMouseEvent) => {
      const label = e.features?.[0]?.properties?.label;
      if (typeof label === "string") popup.setLngLat(e.lngLat).setText(label).addTo(m);
    };
    const setup = () => {
      if (!m.getSource(SRC)) m.addSource(SRC, { type: "geojson", data: latest.current() });
      const color = lineColor();
      const paint = {
        "line-color": color,
        "line-width": ["get", "width"] as maplibregl.ExpressionSpecification,
        "line-opacity": ["get", "opacity"] as maplibregl.ExpressionSpecification,
      };
      if (!m.getLayer("mc-links-direct"))
        m.addLayer({
          id: "mc-links-direct",
          type: "line",
          source: SRC,
          filter: ["==", ["get", "kind"], "direct"],
          paint,
        });
      if (!m.getLayer("mc-links-relay"))
        m.addLayer({
          id: "mc-links-relay",
          type: "line",
          source: SRC,
          filter: ["==", ["get", "kind"], "relay"],
          paint: { ...paint, "line-dasharray": [2, 2] },
        });
      for (const l of LAYERS) m.on("click", l, onClick);
    };
    const cancel = whenStyleReady(m, setup);
    return () => {
      cancel();
      popup.remove();
      for (const l of LAYERS) {
        m.off("click", l, onClick);
        if (m.getLayer(l)) m.removeLayer(l);
      }
      if (m.getSource(SRC)) m.removeSource(SRC);
    };
  }, [map, styleEpoch]);

  useEffect(() => {
    const src = map?.getSource(SRC) as maplibregl.GeoJSONSource | undefined;
    src?.setData(latest.current());
  }, [map, links, styleEpoch]);

  return (
    <div className="maptools-legend mc-legend" role="note">
      <span>{LINKS_VIEWPOINT}</span>
      <span>
        <i className="mc-key direct" aria-hidden="true" /> direct <i className="mc-key relay" aria-hidden="true" />{" "}
        relay leg · wider = stronger · fainter = older
      </span>
      <a href={meshmapUrl()} target="_blank" rel="noopener noreferrer">
        Open MeshMap
      </a>
      <span className="muted">{MESHMAP_ATTRIBUTION}</span>
    </div>
  );
}
