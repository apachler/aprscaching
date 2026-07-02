// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import { useToolHost } from "./host.js";

/**
 * ToolMapLayers — the host renderer for `map`-capability tools (docs/28 §6). Enabled tools that target the
 * `map` surface contribute a declarative `MapLayerSpec` (points only, no MapLibre access); this syncs them
 * to markers on the shared map. Mounted once by Platform with the live map. Re-reads on tool changes +
 * ticks so a tool that mutates its layer from a background event still shows. Tokens, not raw colour.
 */
const TONE_VAR: Record<string, string> = { accent: "--accent", ok: "--ok", warn: "--warn", bad: "--bad", muted: "--muted", default: "--accent" };

export function ToolMapLayers({ map }: { map: maplibregl.Map | null }) {
  const host = useToolHost();                 // re-renders on enable/disable
  const markers = useRef(new Map<string, maplibregl.Marker>());

  useEffect(() => {
    if (!map) return;
    const sync = () => {
      const seen = new Set<string>();
      for (const { tool, spec } of host.mapLayers()) {
        spec.points.forEach((p, i) => {
          const key = `${tool}:${spec.id}:${i}`;
          seen.add(key);
          let mk = markers.current.get(key);
          if (!mk) {
            const el = document.createElement("div");
            el.className = "tool-map-pin";
            mk = new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([p.lon, p.lat]).addTo(map);
            markers.current.set(key, mk);
          } else {
            mk.setLngLat([p.lon, p.lat]);
          }
          const el = mk.getElement();
          el.style.color = `var(${TONE_VAR[p.tone ?? "default"] ?? "--accent"})`;
          el.textContent = p.glyph ?? "◆";   // ◆ default; a tool may override with its own glyph
          el.title = p.label ?? `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
        });
      }
      for (const [key, mk] of markers.current) if (!seen.has(key)) { mk.remove(); markers.current.delete(key); }
    };
    sync();
    const id = setInterval(sync, 3000);         // pick up background-mutated layers
    return () => { clearInterval(id); for (const [, mk] of markers.current) mk.remove(); markers.current.clear(); };
  }, [map, host]);

  return null;
}
