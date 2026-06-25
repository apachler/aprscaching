import { TYPE_ORDER, TYPE_META } from "../cacheTypes.js";
import { Panel } from "../ui/index.js";
import type { CacheType } from "@aprsweb/shared";

/** Search & filter — text + cache-type multi-select (chips). */
export function FilterPanel(props: {
  filters: { types: CacheType[]; q: string }; setFilters: (f: { types: CacheType[]; q: string }) => void;
  count: number; onClose: () => void;
}) {
  const { filters, setFilters } = props;
  const toggle = (t: CacheType) => setFilters({ ...filters, types: filters.types.includes(t) ? filters.types.filter((x) => x !== t) : [...filters.types, t] });
  return (
    <Panel title={<>⌕ Search &amp; filter</>} onClose={props.onClose}>
      <label>Search
        <input autoFocus value={filters.q} placeholder="code or title…" onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
      </label>
      <h4>Cache type</h4>
      <div className="badges">
        {TYPE_ORDER.map((t) => {
          const m = TYPE_META[t]; const on = filters.types.includes(t);
          return <button key={t} className={`chip-btn${on ? " primary" : ""}`} onClick={() => toggle(t)}>{m.glyph} {m.label}</button>;
        })}
      </div>
      <div className="row between mt-5">
        <button className="link" onClick={() => setFilters({ types: [], q: "" })}>clear all</button>
        <span className="muted">{props.count} match{props.count === 1 ? "" : "es"}</span>
      </div>
    </Panel>
  );
}
