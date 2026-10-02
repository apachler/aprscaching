// SPDX-License-Identifier: AGPL-3.0-or-later
import { FILTER_TYPES, TYPE_META, typeGlyph } from "../cacheTypes.js";
import { useTheme } from "../format.js";
import { Panel, useToast, Button, Icon, ChipToggle } from "../ui/index.js";
import { Switch } from "../ui/Switch.js";
import { saveView, type MapViewState } from "../api.js";
import { MESHMAP_ATTRIBUTION, meshmapUrl } from "../meshcom/meshcomView.js";
import type { CacheType } from "@aprscaching/shared";

export interface SpotFilters {
  bands: string[];
  modes: string[];
  sources: string[];
}
const SPOT_BANDS = ["160m", "80m", "40m", "30m", "20m", "17m", "15m", "12m", "10m", "6m", "2m", "70cm"];
const SPOT_MODES = ["SSB", "CW", "FM", "FT8", "DATA"];
const SPOT_SOURCES = ["pota", "sota", "gma", "pskreporter", "dxcluster", "rbn"];

/** Search & filter — text + cache-type multi-select (chips) + network-data scope. */
export function FilterPanel(props: {
  filters: { types: CacheType[]; q: string };
  setFilters: (f: { types: CacheType[]; q: string }) => void;
  includeUnvetted: boolean;
  setIncludeUnvetted: (v: boolean) => void;
  spotsOn: boolean;
  setSpotsOn: (v: boolean) => void;
  stationsOn: boolean;
  setStationsOn: (v: boolean) => void;
  meshcomOn: boolean;
  setMeshcomOn: (v: boolean) => void;
  meshcomLinksOn: boolean;
  setMeshcomLinksOn: (v: boolean) => void;
  spotFilters: SpotFilters;
  setSpotFilters: (f: SpotFilters) => void;
  getViewState: () => MapViewState;
  count: number;
  onClose: () => void;
}) {
  const { filters, setFilters } = props;
  const toast = useToast();
  const phosphor = useTheme() === "phosphor";
  async function share() {
    try {
      const { slug } = await saveView(props.getViewState());
      const url = `${window.location.origin}/?v=${slug}`;
      await navigator.clipboard?.writeText(url).catch(() => {});
      toast("Share link copied");
    } catch (e) {
      toast((e as Error).message);
    }
  }
  const toggle = (t: CacheType) =>
    setFilters({
      ...filters,
      types: filters.types.includes(t) ? filters.types.filter((x) => x !== t) : [...filters.types, t],
    });
  const toggleSpot = (key: keyof SpotFilters, v: string) => {
    const cur = props.spotFilters[key];
    props.setSpotFilters({ ...props.spotFilters, [key]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] });
  };
  return (
    <Panel title={<>⌕ Search &amp; filter</>} onClose={props.onClose}>
      <label>
        Search
        <input
          autoFocus
          value={filters.q}
          placeholder="code or title…"
          onChange={(e) => setFilters({ ...filters, q: e.target.value })}
        />
      </label>
      <h4>Cache type</h4>
      <div className="badges">
        {FILTER_TYPES.map((t) => {
          const m = TYPE_META[t];
          const on = filters.types.includes(t);
          return (
            <ChipToggle key={t} pressed={on} onChange={() => toggle(t)}>
              {typeGlyph(m, phosphor)} {m.label}
            </ChipToggle>
          );
        })}
      </div>
      <h4>Network data</h4>
      <div className="row between">
        <label>
          Include unvetted network data
          <span className="muted block">Caches mirrored from peers you haven't vetted. Off by default.</span>
        </label>
        <Switch
          label="Include unvetted network data"
          checked={props.includeUnvetted}
          onChange={props.setIncludeUnvetted}
        />
      </div>
      <h4>Live layers</h4>
      <div className="row between">
        <label>
          Live stations
          <span className="muted block">
            Plot live APRS stations on the map; tap a pin to inspect. Off by default; this browser remembers it.
          </span>
        </label>
        <Switch label="Live stations" checked={props.stationsOn} onChange={props.setStationsOn} />
      </div>
      <div className="row between">
        <label>
          MeshCom
          <span className="muted block">
            MeshCom nodes as this station's MeshCom node heard them, marked with an M; a dashed ring means heard only
            through the MeshCom server. This browser remembers it.
          </span>
        </label>
        <Switch label="MeshCom" checked={props.meshcomOn} onChange={props.setMeshcomOn} />
      </div>
      {props.meshcomOn ? (
        <div className="row between sub">
          <label>
            MeshCom links
            <span className="muted block">
              Who the node heard directly or through relays in the last 24 hours: its own view, not the whole network.
            </span>
          </label>
          <Switch label="MeshCom links" checked={props.meshcomLinksOn} onChange={props.setMeshcomLinksOn} />
        </div>
      ) : (
        <p className="muted fine">Turn MeshCom on to show its links.</p>
      )}
      <p className="muted fine">
        The whole MeshCom network:{" "}
        <a href={meshmapUrl()} target="_blank" rel="noopener noreferrer">
          Open MeshMap
        </a>{" "}
        ({MESHMAP_ATTRIBUTION})
      </p>
      <div className="row between">
        <label>
          Activity spots
          <span className="muted block">Live POTA/SOTA activations on the map. Off by default; opt-in.</span>
        </label>
        <Switch label="Activity spots" checked={props.spotsOn} onChange={props.setSpotsOn} />
      </div>
      {props.spotsOn && (
        <div className="spot-filters">
          <div className="filter-row">
            <span className="filter-label">Band</span>
            <div className="badges">
              {SPOT_BANDS.map((b) => (
                <ChipToggle
                  key={b}
                  pressed={props.spotFilters.bands.includes(b)}
                  onChange={() => toggleSpot("bands", b)}
                >
                  {b}
                </ChipToggle>
              ))}
            </div>
          </div>
          <div className="filter-row">
            <span className="filter-label">Mode</span>
            <div className="badges">
              {SPOT_MODES.map((md) => (
                <ChipToggle
                  key={md}
                  pressed={props.spotFilters.modes.includes(md)}
                  onChange={() => toggleSpot("modes", md)}
                >
                  {md}
                </ChipToggle>
              ))}
            </div>
          </div>
          <div className="filter-row">
            <span className="filter-label">Source</span>
            <div className="badges">
              {SPOT_SOURCES.map((s) => (
                <ChipToggle
                  key={s}
                  pressed={props.spotFilters.sources.includes(s)}
                  onChange={() => toggleSpot("sources", s)}
                >
                  {s.toUpperCase()}
                </ChipToggle>
              ))}
            </div>
          </div>
        </div>
      )}
      <h4>Share</h4>
      <div className="row between">
        <span className="muted">Save this map view (centre, layers, filters) as a link.</span>
        <Button onClick={share}>
          <Icon name="link" cp437="" className="lead-ic" />
          Share this view
        </Button>
      </div>
      <div className="row between mt-6">
        <Button variant="quiet" onClick={() => setFilters({ types: [], q: "" })}>
          Clear all
        </Button>
        <span className="muted">
          {props.count} match{props.count === 1 ? "" : "es"}
        </span>
      </div>
    </Panel>
  );
}
