// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * TopBar — the cacher/operator top chrome: logo, type filter, search, in-view count, identity chip,
 * desktop nav and the primary "Hide a cache" action. The header is identical in every app mode —
 * switching into "hide" must not reshuffle the chrome. Reused by the app and the demo harness so the
 * teaser shows the same chrome everywhere (ui-ux §6: one component, no bespoke one-offs).
 */
import { ASSET } from "./brand.js";
import { Icon, Ico } from "./ui/index.js";
import { SearchSuggest } from "./search/SearchSuggest.js";
import type { SearchHitCache, SearchHitStation } from "@aprsweb/shared";

export function TopBar(props: {
  callsign: string;
  verified: boolean;
  onAccount: () => void;
  onHide: () => void;
  count: number;
  queued: number;
  onFilters: () => void;
  filtered: boolean;
  q: string;
  onSearch: (v: string) => void;
  onSearchSubmit: (v: string) => void;
  onPickCache: (hit: SearchHitCache) => void;
  onPickStation: (hit: SearchHitStation) => void;
  onNearby: () => void;
  onActivity: () => void;
  onProfile: () => void;
  onDocs: () => void;
  sysop?: boolean;
  onAdmin?: () => void;
}) {
  return (
    <header className="topbar">
      <img className="logo" src={ASSET.wordmark} alt="APRScaching" />
      <button
        className={`icon filter-ic${props.filtered ? " on" : ""}`}
        onClick={props.onFilters}
        title="Filter by type"
        aria-label="Filter caches by type"
      >
        <Icon name="filter" size={16} />
      </button>
      <SearchSuggest
        q={props.q}
        onChange={props.onSearch}
        onSubmitRaw={props.onSearchSubmit}
        onPickCache={props.onPickCache}
        onPickStation={props.onPickStation}
      />
      <span className="muted">
        · {props.count} caches{props.filtered ? " (filtered)" : " in view"}
      </span>
      {props.queued > 0 && (
        <span className="muted" title="finds saved offline">
          · <Ico e="📴 " />
          {props.queued} queued
        </span>
      )}
      <span className="spacer" />
      {/* Manual: the single entry point on every breakpoint — a compact icon in the top chrome. */}
      <button className="icon help-ic" onClick={props.onDocs} title="Manual" aria-label="Open the manual">
        <Icon name="info" size={16} />
      </button>
      <button className={`idchip${props.verified ? " ok" : ""}`} onClick={props.onAccount} title="Account & callsigns">
        {props.callsign ? (
          <>
            <span className="mono">{props.callsign}</span>
            {props.verified ? <Icon name="check" size={14} /> : <span className="idchip-x">unverified</span>}
          </>
        ) : (
          <>
            <Icon name="profile" size={15} /> Sign in
          </>
        )}
      </button>
      <span className="nav-desktop">
        <button onClick={props.onNearby}>Nearby</button>
        <button onClick={props.onActivity}>Activity</button>
        {props.sysop && props.onAdmin && (
          <button onClick={props.onAdmin} title="Instance admin — operator only">
            <Ico e="🛡" c="ADM" />
          </button>
        )}
        <button onClick={props.onProfile} title="Profile — identity & advanced tools">
          <Ico e="👤" c="ME" />
        </button>
      </span>
      <button className="primary hide-cta" onClick={props.onHide}>
        + Hide a cache
      </button>
    </header>
  );
}
