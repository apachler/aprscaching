import { useState, type CSSProperties } from "react";
import maplibregl from "maplibre-gl";
import { useFmt } from "../format.js";
import { typeMeta } from "../cacheTypes.js";
import { haversine, bearing8, maidenhead } from "../map/geo.js";
import { Panel, EmptyState, Icon } from "../ui/index.js";
import type { MapCache, StationSummary } from "../api.js";

type Filter = "all" | "caches" | "stations";

/** Nearby — caches (operator cards) + live stations, by distance from the map centre. */
export function NearbyPanel(props: {
  caches: MapCache[]; stations: StationSummary[]; map: maplibregl.Map | null;
  selectedId: number | null; onPick: (id: number) => void; onClose: () => void;
}) {
  const fmt = useFmt();
  const [filter, setFilter] = useState<Filter>("all");
  const c = props.map?.getCenter();
  const here = c ? { lat: c.lat, lon: c.lng } : null;
  const grid = here ? maidenhead(here.lat, here.lon) : null;
  const dist = (m: { lat: number | null; lon: number | null }) =>
    (here && m.lat != null && m.lon != null) ? haversine(here.lat, here.lon, m.lat, m.lon) : Infinity;
  const caches = [...props.caches].filter((m) => m.lat != null && m.lon != null).sort((a, b) => dist(a) - dist(b)).slice(0, 100);
  const stations = [...props.stations].filter((s) => s.lat != null && s.lon != null).sort((a, b) => dist(a) - dist(b)).slice(0, 60);
  const showCaches = filter === "all" || filter === "caches";
  const showStations = filter === "all" || filter === "stations";
  const chip = (key: Filter, label: string) => (
    <button className={filter === key ? "on" : ""} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>
  );
  return (
    <Panel title="Nearby" onClose={props.onClose}>
      <div className="nearby-h">
        <span className="muted">nearest first</span>
        {grid && <span className="nearby-grid">{grid}</span>}
      </div>
      <div className="seg-chips">{chip("all", "All")}{chip("caches", "Caches")}{chip("stations", "Stations")}</div>

      {showCaches && (<>
        <div className="ulabel cardsec">Caches · {caches.length}</div>
        {caches.length === 0 ? <EmptyState>No caches in view — pan or zoom the map.</EmptyState> : (
          <ul className="cardlist">
            {caches.map((m) => {
              const meta = typeMeta(m.type);
              const d = dist(m);
              const src = m.source === "native" ? "APRScaching" : (m.sourceName ?? m.source);
              return (
                <li key={m.globalId}>
                  <button className={`ccard${m.id === props.selectedId ? " active" : ""}`} disabled={m.id == null}
                          onClick={() => m.id != null && props.onPick(m.id)}>
                    <span className="ccard-ico" style={{ ["--tc"]: meta.color } as CSSProperties}>{meta.glyph}</span>
                    <span className="ccard-b">
                      <span className="ccard-name">{m.title}</span>
                      <span className="ccard-sub">{m.code} · {src}</span>
                      <span className="ccard-meta">
                        <span className="dtpill">D{m.difficulty}/T{m.terrain}</span>
                        <span className="ccard-dist">{d === Infinity ? "" : `${fmt.distance(d)} ${here && m.lat != null && m.lon != null ? bearing8(here.lat, here.lon, m.lat, m.lon) : ""}`}</span>
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </>)}

      {showStations && (<>
        <div className="ulabel cardsec top">Live stations · {stations.length}</div>
        {stations.length === 0
          ? <EmptyState>No live stations — enable the live layer in the Workbench.</EmptyState>
          : stations.map((s) => (
            <div key={s.callsign} className="srow">
              <Icon name="navigation" size={18} className="tcol B" style={{ transform: `rotate(${(s.course ?? 0)}deg)` }} />
              <div className="srow-b">
                <div className="srow-call">{s.callsign}</div>
                <div className="srow-sub">{s.symbol ?? "—"}{s.speedKn ? ` · ${fmt.speed(s.speedKn)}` : ""}</div>
              </div>
              <div className="srow-heard">{fmt.ago(s.lastSeen)}</div>
            </div>
          ))}
      </>)}
    </Panel>
  );
}
