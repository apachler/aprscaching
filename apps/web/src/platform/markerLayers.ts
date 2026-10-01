// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The map's DOM-marker layers: caches, live APRS stations and activity spots. Each hook diffs its
 * list against the markers already on the map (add, update in place, remove the rest), so a refresh
 * never rebuilds every marker. DOM markers are overlays, not style layers, so they survive a basemap
 * style swap. Click handlers are read through a ref: a fresh closure does not rebuild the layer.
 */
import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import type { MapCache, MeshcomNode, StationSummary, Spot } from "../api.js";
import { nodePinClass, nodeTitle } from "../meshcom/meshcomView.js";
import { typeMeta } from "../cacheTypes.js";
import { roleMeta } from "../stationRoles.js";
import { aprsGlyph } from "../aprsGlyph.js";
import { ASSET } from "../brand.js";

/** Keep `fn` current without making it an effect dependency. */
function useLatest<T>(fn: T) {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  return ref;
}

/** Remove every marker whose key is not in `seen`. */
function prune(markers: Map<string, maplibregl.Marker>, seen: Set<string>) {
  for (const [key, mk] of markers) {
    if (!seen.has(key)) {
      mk.remove();
      markers.delete(key);
    }
  }
}

/** Cache pins (living caches use the beacon icon); `phosphor` swaps each type glyph for its CP437 one. */
export function useCacheMarkers(
  map: maplibregl.Map | null,
  caches: MapCache[],
  phosphor: boolean,
  onPick: (c: MapCache) => void,
): void {
  const markers = useRef(new Map<string, maplibregl.Marker>());
  const pick = useLatest(onPick);
  useEffect(() => {
    if (!map) return;
    const seen = new Set<string>();
    for (const c of caches) {
      if (c.lat == null || c.lon == null) continue;
      seen.add(c.globalId);
      const meta = typeMeta(c.type);
      let el: HTMLElement;
      const existing = markers.current.get(c.globalId);
      if (existing) {
        el = existing.getElement();
        // keep the class + glyph in sync if a cache flips mirrored↔native or the theme flips
        if (c.type !== "aprs_living") {
          // toggle, never assign: className would drop the maplibregl-marker classes that position the pin
          el.classList.toggle("mirrored", !!c.mirrored);
          const span = el.querySelector("span");
          if (span) span.textContent = phosphor ? meta.cog : meta.glyph;
        }
      } else {
        let anchor: maplibregl.PositionAnchor = "bottom";
        if (c.type === "aprs_living") {
          // living caches ARE a beaconing station — use the brand beacon icon
          const img = document.createElement("img");
          img.className = "beacon-pin";
          img.src = ASSET.beaconBlue;
          anchor = "center";
          el = img;
        } else {
          const btn = document.createElement("button");
          btn.className = `cache-pin${c.mirrored ? " mirrored" : ""}`;
          btn.dataset.ctype = c.type;
          btn.innerHTML = `<span>${phosphor ? meta.cog : meta.glyph}</span>`;
          el = btn;
        }
        markers.current.set(
          c.globalId,
          new maplibregl.Marker({ element: el, anchor }).setLngLat([c.lon, c.lat]).addTo(map),
        );
      }
      // rebind title + click each pass so a cache whose title/mirrored/id changed doesn't keep a stale
      // tooltip or route clicks the wrong way (mirrored vs native).
      el.title = `${c.code} — ${c.title}${c.mirrored ? ` · via ${c.origin}` : ""}`;
      el.onclick = (ev) => {
        ev.stopPropagation();
        pick.current(c);
      };
    }
    prune(markers.current, seen);
    focusOnlyVisible(map, markers.current);
  }, [map, caches, phosphor, pick]);
  // Keyboard focus reaches only the pins on screen: a pin outside the view is not something to land on
  // (WCAG 2.4.3), and the Nearby list reaches every cache anyway.
  useEffect(() => {
    if (!map) return;
    const sync = () => focusOnlyVisible(map, markers.current);
    map.on("moveend", sync);
    return () => {
      map.off("moveend", sync);
    };
  }, [map]);
}

function focusOnlyVisible(map: maplibregl.Map, markers: Map<string, maplibregl.Marker>): void {
  const bounds = map.getBounds();
  for (const m of markers.values()) m.getElement().tabIndex = bounds.contains(m.getLngLat()) ? 0 : -1;
}

/** Live station pins. Glyph precedence: station role → the station's own APRS symbol → moving/idle dot. */
export function useStationMarkers(
  map: maplibregl.Map | null,
  stations: StationSummary[],
  phosphor: boolean,
  onPick: (callsign: string) => void,
): void {
  const markers = useRef(new Map<string, maplibregl.Marker>());
  const pick = useLatest(onPick);
  useEffect(() => {
    if (!map) return;
    const seen = new Set<string>();
    for (const s of stations) {
      if (s.lat == null || s.lon == null) continue;
      seen.add(s.callsign);
      let mk = markers.current.get(s.callsign);
      if (!mk) {
        const btn = document.createElement("button");
        btn.className = "station-pin";
        btn.innerHTML = "<span></span>";
        btn.onclick = (ev) => {
          ev.stopPropagation();
          pick.current(s.callsign);
        };
        mk = new maplibregl.Marker({ element: btn, anchor: "center" }).setLngLat([s.lon, s.lat]).addTo(map);
        markers.current.set(s.callsign, mk);
      } else {
        mk.setLngLat([s.lon, s.lat]);
      }
      const el = mk.getElement();
      const role = roleMeta(s.roles);
      const aprs = role ? null : aprsGlyph(s.symbol);
      const label = role ? role.label : aprs?.label;
      el.title = `${s.callsign}${label ? ` · ${label}` : ""}${s.comment ? ` — ${s.comment}` : ""}`;
      el.classList.toggle("role", !!role);
      el.style.background = role ? role.color : "";
      el.style.color = role ? "var(--ink-tier)" : "";
      const moving = s.course != null && !!s.speedKn;
      const span = el.querySelector("span") as HTMLElement;
      span.textContent = role
        ? phosphor
          ? role.cog
          : role.glyph
        : aprs
          ? phosphor
            ? aprs.cog
            : aprs.glyph
          : moving
            ? phosphor
              ? "→"
              : "➤"
            : "•";
      // only the bare directional dot rotates with course; a concrete symbol glyph stays upright
      span.style.transform = !role && !aprs && moving ? `rotate(${(s.course ?? 0) - 90}deg)` : "";
    }
    prune(markers.current, seen);
  }, [map, stations, phosphor, pick]);
}

/**
 * MeshCom node pins: the station's APRS symbol in a station pin with a MeshCom ring and an "M" tag, so the
 * difference does not rest on colour; a node heard only via the MeshCom server gets a dashed ring.
 */
export function useMeshcomMarkers(
  map: maplibregl.Map | null,
  nodes: MeshcomNode[],
  phosphor: boolean,
  onPick: (callsign: string) => void,
): void {
  const markers = useRef(new Map<string, maplibregl.Marker>());
  const pick = useLatest(onPick);
  useEffect(() => {
    if (!map) return;
    const seen = new Set<string>();
    for (const n of nodes) {
      seen.add(n.callsign);
      let mk = markers.current.get(n.callsign);
      if (!mk) {
        const btn = document.createElement("button");
        btn.className = nodePinClass(n);
        btn.innerHTML = "<span></span>";
        btn.onclick = (ev) => {
          ev.stopPropagation();
          pick.current(n.callsign);
        };
        mk = new maplibregl.Marker({ element: btn, anchor: "center" }).setLngLat([n.lon, n.lat]).addTo(map);
        markers.current.set(n.callsign, mk);
      } else {
        mk.setLngLat([n.lon, n.lat]);
      }
      const el = mk.getElement();
      // toggle, never assign: className would drop the maplibregl-marker classes that position the pin
      el.classList.toggle("via-server", n.via === "server");
      el.title = nodeTitle(n);
      el.setAttribute("aria-label", nodeTitle(n));
      const aprs = aprsGlyph(n.symbol);
      (el.querySelector("span") as HTMLElement).textContent = aprs ? (phosphor ? aprs.cog : aprs.glyph) : "•";
    }
    prune(markers.current, seen);
  }, [map, nodes, phosphor, pick]);
}

/** Activity-spot pins: an opt-in overlay with its own marker class. */
export function useSpotMarkers(map: maplibregl.Map | null, spots: Spot[], onPick: (s: Spot) => void): void {
  const markers = useRef(new Map<string, maplibregl.Marker>());
  const pick = useLatest(onPick);
  useEffect(() => {
    if (!map) return;
    const seen = new Set<string>();
    for (const s of spots) {
      seen.add(s.id);
      let mk = markers.current.get(s.id);
      if (!mk) {
        const btn = document.createElement("button");
        btn.className = "spot-pin";
        btn.innerHTML = "<span>◎</span>";
        mk = new maplibregl.Marker({ element: btn, anchor: "center" }).setLngLat([s.lon, s.lat]).addTo(map);
        markers.current.set(s.id, mk);
      } else {
        mk.setLngLat([s.lon, s.lat]);
      }
      // rebind onclick + title every refresh: an existing marker's `s` would otherwise be the stale
      // object captured at creation, so a spot that changed band/mode/ref would open the old card.
      const el = mk.getElement();
      el.onclick = (ev) => {
        ev.stopPropagation();
        pick.current(s);
      };
      el.title = `${s.callsign}${s.ref ? ` @ ${s.ref}` : ""}${s.band ? ` · ${s.band}` : ""}${s.mode ? ` ${s.mode}` : ""}`;
    }
    prune(markers.current, seen);
  }, [map, spots, pick]);
}
