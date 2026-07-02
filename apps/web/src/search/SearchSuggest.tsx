// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { searchSuggest, type SearchHitCache, type SearchHitStation } from "../api.js";
import { Icon } from "../ui/index.js";

/**
 * Enriched as-you-type search (docs/design/11 M2). A real ARIA combobox over the existing top-bar search:
 * debounced server suggestions (caches + stations) in an accessible listbox, keyboard-navigable
 * (↑/↓/Enter/Esc). Typing still drives the live in-view text filter (onChange); Enter with no active
 * suggestion falls back to the grid / lat-lon fly-to (onSubmitRaw). In-flight requests are aborted so
 * only the latest query wins.
 */
type Hit = SearchHitCache | SearchHitStation;

export function SearchSuggest(props: {
  q: string;
  onChange: (v: string) => void;                 // keeps the in-view text filter live
  onSubmitRaw: (v: string) => void;              // grid / lat-lon fallback (Enter, no active hit)
  onPickCache: (hit: SearchHitCache) => void;
  onPickStation: (hit: SearchHitStation) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(-1);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const acRef = useRef<AbortController | null>(null);

  // debounced fetch; abort the previous request so stale responses can't overwrite a newer one
  useEffect(() => {
    const q = props.q.trim();
    if (q.length < 2) { setHits([]); setOpen(false); setLoading(false); acRef.current?.abort(); return; }
    setLoading(true);
    const t = setTimeout(() => {
      acRef.current?.abort();
      const ac = new AbortController(); acRef.current = ac;
      searchSuggest(q, ac.signal)
        .then((r) => { setHits([...r.caches, ...r.stations]); setActive(-1); setOpen(true); })
        .catch((e) => { if ((e as Error).name !== "AbortError") setHits([]); })
        .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    }, 180);
    return () => clearTimeout(t);
  }, [props.q]);

  // close when focus/click leaves the widget
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (!wrapRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function pick(h: Hit) {
    setOpen(false);
    if (h.kind === "cache") props.onPickCache(h); else props.onPickStation(h);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, hits.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, -1)); }
    else if (e.key === "Enter") {
      if (open && active >= 0 && hits[active]) { e.preventDefault(); pick(hits[active]!); }
      else { setOpen(false); props.onSubmitRaw(props.q); }
    } else if (e.key === "Escape") { setOpen(false); }
  }

  const showEmpty = open && !loading && hits.length === 0 && props.q.trim().length >= 2;

  return (
    <div className="topsearch-wrap" ref={wrapRef}>
      <label className="topsearch">
        <Icon name="search" size={16} />
        <input
          role="combobox" aria-expanded={open} aria-controls="search-listbox" aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `search-opt-${active}` : undefined}
          value={props.q} placeholder="Search caches, stations, or grid…" aria-label="Search caches and stations"
          onChange={(e) => props.onChange(e.target.value)}
          onFocus={() => { if (hits.length) setOpen(true); }}
          onKeyDown={onKeyDown}
        />
        {loading && <span className="search-spin" aria-hidden="true" />}
      </label>
      {(open && hits.length > 0) && (
        <ul className="search-pop" id="search-listbox" role="listbox" aria-label="Search results">
          {hits.map((h, i) => (
            <li
              key={h.kind === "cache" ? `c${h.id}` : `s${h.callsign}`}
              id={`search-opt-${i}`} role="option" aria-selected={i === active}
              className={`search-opt${i === active ? " active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(h); }}
            >
              {h.kind === "cache"
                ? <><span className="so-kind cache">{h.code}</span><span className="so-title">{h.title}</span><span className="so-meta mono">{h.ownerCall}</span></>
                : <><span className="so-kind stn">RF</span><span className="so-title mono">{h.callsign}</span>{h.comment && <span className="so-meta">{h.comment}</span>}</>}
            </li>
          ))}
        </ul>
      )}
      {showEmpty && (
        <ul className="search-pop" role="listbox" aria-label="Search results">
          <li className="search-empty">No matches — try a grid like <span className="mono">JN77</span> or “lat, lon”.</li>
        </ul>
      )}
    </div>
  );
}
