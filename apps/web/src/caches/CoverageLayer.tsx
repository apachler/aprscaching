// SPDX-License-Identifier: AGPL-3.0-or-later
// maplibre-gl does not declare the ambient GeoJSON namespace; import it explicitly.
import type * as GeoJSON from "geojson";
import { useEffect, useRef, useState } from "react";
import type * as maplibregl from "maplibre-gl";
import type { CoverageSite } from "@aprscaching/shared";
import { getCoverage, type BBox } from "../api.js";
import { tokenHex, useAppliedTheme, whenStyleReady } from "../map/mapPaint.js";
import { boxHolds, coverageFeatures, fetchBox } from "./coverage.js";

/**
 * The hide form's radio coverage on the map: a range circle per receiver, an attested receiving site in the
 * heard-on-the-air colour and a digipeater or IGate in the APRS-IS colour (the `--map-heard-*` tokens), the
 * outline dashed where the range is the default for a station that advertises none.
 */
const SRC = "hide-coverage";
const FILL = "hide-coverage-fill";
const LINE = "hide-coverage-line";
const LINE_EST = "hide-coverage-line-est";
const LAYERS = [FILL, LINE, LINE_EST];

/** The colour per site kind, from the theme's tokens, as a MapLibre expression. */
const kindColor = (): maplibregl.ExpressionSpecification => [
  "case",
  ["get", "attested"],
  tokenHex("--map-heard-rf"),
  tokenHex("--map-heard-is"),
];

export function CoverageLayer(props: { map: maplibregl.Map | null; sites: CoverageSite[]; styleEpoch: number }) {
  const { map, sites, styleEpoch } = props;
  const theme = useAppliedTheme();
  const data = () => coverageFeatures(sites) as GeoJSON.FeatureCollection;
  const latest = useRef(data);
  latest.current = data;

  useEffect(() => {
    const m = map;
    if (!m) return;
    const setup = () => {
      if (!m.getSource(SRC)) m.addSource(SRC, { type: "geojson", data: latest.current() });
      const color = kindColor();
      if (!m.getLayer(FILL))
        m.addLayer({
          id: FILL,
          type: "fill",
          source: SRC,
          paint: { "fill-color": color, "fill-opacity": ["case", ["get", "attested"], 0.16, 0.08] },
        });
      if (!m.getLayer(LINE))
        m.addLayer({
          id: LINE,
          type: "line",
          source: SRC,
          filter: ["!", ["get", "estimated"]],
          paint: { "line-color": color, "line-width": ["case", ["get", "attested"], 2.5, 1.5] },
        });
      if (!m.getLayer(LINE_EST))
        m.addLayer({
          id: LINE_EST,
          type: "line",
          source: SRC,
          filter: ["get", "estimated"],
          paint: {
            "line-color": color,
            "line-width": ["case", ["get", "attested"], 2.5, 1.5],
            "line-dasharray": [3, 2],
          },
        });
    };
    const cancel = whenStyleReady(m, setup);
    return () => {
      cancel();
      for (const l of LAYERS) if (m.getLayer(l)) m.removeLayer(l);
      if (m.getSource(SRC)) m.removeSource(SRC);
    };
  }, [map, styleEpoch]);

  // a theme change repaints the circles in the new theme's colours
  useEffect(() => {
    if (!map) return;
    const color = kindColor();
    if (map.getLayer(FILL)) map.setPaintProperty(FILL, "fill-color", color);
    for (const l of [LINE, LINE_EST]) if (map.getLayer(l)) map.setPaintProperty(l, "line-color", color);
  }, [map, theme, styleEpoch]);

  useEffect(() => {
    const src = map?.getSource(SRC) as maplibregl.GeoJSONSource | undefined;
    src?.setData(latest.current());
  }, [map, sites, styleEpoch]);

  return null;
}

/** The coverage the hide form shows: the sites, whether a request is out, and why there are none. */
export interface CoverageState {
  sites: CoverageSite[];
  loading: boolean;
  /** Why no circles show: the request failed, or the view is too wide to ask for. */
  problem: "failed" | "zoom" | null;
  /** The area held more receivers than one answer carries. */
  truncated: boolean;
}

const IDLE: CoverageState = { sites: [], loading: false, problem: null, truncated: false };

const viewOf = (m: maplibregl.Map): BBox => {
  const b = m.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
};

/**
 * The receivers around the map's view while `on`: asked once for a box padded around the view, and again only
 * when the view leaves that box, so panning about the pin costs no request.
 */
export function useCoverage(map: maplibregl.Map | null, on: boolean): CoverageState {
  const [state, setState] = useState<CoverageState>(IDLE);
  useEffect(() => {
    if (!map || !on) {
      setState(IDLE);
      return;
    }
    let fetched: BBox | null = null;
    let seq = 0;
    const refresh = () => {
      const view = viewOf(map);
      if (fetched && boxHolds(fetched, view)) return;
      const box = fetchBox(view);
      if (!box) {
        fetched = null;
        setState({ ...IDLE, problem: "zoom" });
        return;
      }
      const mine = ++seq;
      setState((s) => ({ ...s, loading: true, problem: null }));
      getCoverage(box)
        .then((r) => {
          if (mine !== seq) return;
          fetched = box;
          setState({ sites: r.sites, loading: false, problem: null, truncated: r.truncated });
        })
        .catch(() => {
          if (mine === seq) setState({ ...IDLE, problem: "failed" });
        });
    };
    refresh();
    map.on("moveend", refresh);
    return () => {
      seq++;
      map.off("moveend", refresh);
    };
  }, [map, on]);
  return state;
}
