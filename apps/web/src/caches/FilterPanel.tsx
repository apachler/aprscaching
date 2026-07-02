// SPDX-License-Identifier: AGPL-3.0-or-later
import { TYPE_ORDER, TYPE_META, typeGlyph } from "../cacheTypes.js";
import { useTheme } from "../format.js";
import { Panel, useToast, Ico } from "../ui/index.js";
import { Switch } from "../ui/Switch.js";
import { saveView, type MapViewState } from "../api.js";
import type { CacheType } from "@aprsweb/shared";

export interface SpotFilters { bands: string[]; modes: string[]; sources: string[] }
const SPOT_BANDS = ["160m", "80m", "40m", "30m", "20m", "17m", "15m", "12m", "10m", "6m", "2m", "70cm"];
const SPOT_MODES = ["SSB", "CW", "FM", "FT8", "DATA"];
const SPOT_SOURCES = ["pota", "sota", "gma", "pskreporter", "dxcluster", "rbn"];

/** Search & filter — text + cache-type multi-select (chips) + network-data scope. */
export function FilterPanel(props: {
  filters: { types: CacheType[]; q: string }; setFilters: (f: { types: CacheType[]; q: string }) => void;
  includeUnvetted: boolean; setIncludeUnvetted: (v: boolean) => void;
  spotsOn: boolean; setSpotsOn: (v: boolean) => void;
  stationsOn: boolean; setStationsOn: (v: boolean) => void;
  spotFilters: SpotFilters; setSpotFilters: (f: SpotFilters) => void;
  getViewState: () => MapViewState;
  count: number; onClose: () => void;
}) {
  const { filters, setFilters } = props;
  const toast = useToast();
  const cogmind = useTheme() === "cogmind";
  async function share() {
    try {
      const { slug } = await saveView(props.getViewState());
      const url = `${window.location.origin}/?v=${slug}`;
      await navigator.clipboard?.writeText(url).catch(() => {});
      toast("Share link copied");
    } catch (e) { toast((e as Error).message); }
  }
  const toggle = (t: CacheType) => setFilters({ ...filters, types: filters.types.includes(t) ? filters.types.filter((x) => x !== t) : [...filters.types, t] });
  const toggleSpot = (key: keyof SpotFilters, v: string) => {
    const cur = props.spotFilters[key];
    props.setSpotFilters({ ...props.spotFilters, [key]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] });
  };
  return (
    <Panel title={<>⌕ Search &amp; filter</>} onClose={props.onClose}>
      <label>Search
        <input autoFocus value={filters.q} placeholder="code or title…" onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
      </label>
      <h4>Cache type</h4>
      <div className="badges">
        {TYPE_ORDER.map((t) => {
          const m = TYPE_META[t]; const on = filters.types.includes(t);
          return <button key={t} className={`chip-btn${on ? " primary" : ""}`} onClick={() => toggle(t)}>{typeGlyph(m, cogmind)} {m.label}</button>;
        })}
      </div>
      <h4>Network data</h4>
      <div className="row between">
        <label>Include unvetted network data
          <span className="muted block">Caches mirrored from peers you haven't vetted. Off by default.</span>
        </label>
        <Switch label="Include unvetted network data" checked={props.includeUnvetted} onChange={props.setIncludeUnvetted} />
      </div>
      <h4>Live layers</h4>
      <div className="row between">
        <label>Live stations
          <span className="muted block">Plot live APRS stations on the map; tap a pin to inspect. Off by default; opt-in.</span>
        </label>
        <Switch label="Live stations" checked={props.stationsOn} onChange={props.setStationsOn} />
      </div>
      <div className="row between">
        <label>Activity spots
          <span className="muted block">Live POTA/SOTA activations on the map. Off by default; opt-in.</span>
        </label>
        <Switch label="Activity spots" checked={props.spotsOn} onChange={props.setSpotsOn} />
      </div>
      {props.spotsOn && (
        <div className="spot-filters">
          <div className="filter-row"><span className="filter-label">Band</span>
            <div className="badges">{SPOT_BANDS.map((b) => (
              <button key={b} className={`chip-btn${props.spotFilters.bands.includes(b) ? " primary" : ""}`} onClick={() => toggleSpot("bands", b)}>{b}</button>
            ))}</div></div>
          <div className="filter-row"><span className="filter-label">Mode</span>
            <div className="badges">{SPOT_MODES.map((md) => (
              <button key={md} className={`chip-btn${props.spotFilters.modes.includes(md) ? " primary" : ""}`} onClick={() => toggleSpot("modes", md)}>{md}</button>
            ))}</div></div>
          <div className="filter-row"><span className="filter-label">Source</span>
            <div className="badges">{SPOT_SOURCES.map((s) => (
              <button key={s} className={`chip-btn${props.spotFilters.sources.includes(s) ? " primary" : ""}`} onClick={() => toggleSpot("sources", s)}>{s.toUpperCase()}</button>
            ))}</div></div>
        </div>
      )}
      <h4>Share</h4>
      <div className="row between">
        <span className="muted">Save this map view (centre, layers, filters) as a link.</span>
        <button onClick={share}><Ico e="🔗 " />Share this view</button>
      </div>
      <div className="row between mt-5">
        <button className="link" onClick={() => setFilters({ types: [], q: "" })}>clear all</button>
        <span className="muted">{props.count} match{props.count === 1 ? "" : "es"}</span>
      </div>
    </Panel>
  );
}
