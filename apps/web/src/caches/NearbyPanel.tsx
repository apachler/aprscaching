import maplibregl from "maplibre-gl";
import { useFmt } from "../format.js";
import { typeMeta } from "../cacheTypes.js";
import { haversine } from "../map/geo.js";
import { Panel, EmptyState } from "../ui/index.js";
import type { MapCache } from "../api.js";

/** Nearby — caches by distance from the map centre. */
export function NearbyPanel(props: { caches: MapCache[]; map: maplibregl.Map | null; onPick: (id: number) => void; onClose: () => void }) {
  const fmt = useFmt();
  const c = props.map?.getCenter();
  const here = c ? { lat: c.lat, lon: c.lng } : null;
  const dist = (m: MapCache) => (here && m.lat != null && m.lon != null) ? haversine(here.lat, here.lon, m.lat, m.lon) : Infinity;
  const list = [...props.caches].filter((m) => m.lat != null && m.lon != null).sort((a, b) => dist(a) - dist(b)).slice(0, 100);
  return (
    <Panel title="Nearby" onClose={props.onClose}>
      {list.length === 0
        ? <EmptyState>No caches in view — pan or zoom the map to find some.</EmptyState>
        : <p className="muted">{list.length} caches, nearest first (from the map centre)</p>}
      <ul className="board">
        {list.map((m) => {
          const meta = typeMeta(m.type);
          return (
            <li key={m.globalId} className={m.id != null ? "clickable" : ""} onClick={() => m.id != null && props.onPick(m.id)}>
              <span className="dot" style={{ background: meta.color }} />
              <span className="flex-1"><span className="mono">{m.code}</span> <span className="muted">{m.title}</span></span>
              <span className="mono muted">{dist(m) === Infinity ? "" : fmt.distance(dist(m))}</span>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
