// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * TopBar — the cacher/operator top chrome: logo, type filter, search, in-view count, identity chip,
 * desktop nav and the primary "Hide a cache" action. The header is identical in every app mode —
 * switching into "hide" must not reshuffle the chrome. Reused by the app and the demo harness so the
 * teaser shows the same chrome everywhere (ui-ux §6: one component, no bespoke one-offs).
 */
import { ASSET } from "./brand.js";
import { Button, Icon } from "./ui/index.js";
import { SearchSuggest } from "./search/SearchSuggest.js";
import type { SearchHitCache, SearchHitStation } from "@aprscaching/shared";

export function TopBar(props: {
  callsign: string;
  verified: boolean;
  onAccount: () => void;
  onHide: () => void;
  count: number;
  /** The offline sync's status line ("2 logs waiting · pack “JN77sb” 3 days old"), empty when all is synced. */
  syncLine: string;
  /** Queued logs the instance refused, waiting for the user's choice. */
  attention: number;
  onQueue: () => void;
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
      <Button
        variant="icon"
        className={`filter-ic${props.filtered ? " on" : ""}`}
        onClick={props.onFilters}
        title="Filter by type"
        aria-label="Filter caches by type"
      >
        <Icon name="filter" size={16} />
      </Button>
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
      {props.syncLine && (
        <Button
          variant="quiet"
          className={`queue-chip${props.attention > 0 ? " attn" : ""}`}
          onClick={props.onQueue}
          title="Offline logs and packs"
        >
          <Icon name="offline" cp437="" className="lead-ic" />
          {props.syncLine}
        </Button>
      )}
      <span className="spacer" />
      {/* Manual: the single entry point on every breakpoint — a compact icon in the top chrome. */}
      <Button variant="icon" className="help-ic" onClick={props.onDocs} title="Manual" aria-label="Open the manual">
        <Icon name="info" size={16} />
      </Button>
      <Button className={`idchip${props.verified ? " ok" : ""}`} onClick={props.onAccount} title="Account & callsigns">
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
      </Button>
      <span className="nav-desktop">
        <Button onClick={props.onNearby}>Nearby</Button>
        <Button onClick={props.onActivity}>Activity</Button>
        {props.sysop && props.onAdmin && (
          <Button onClick={props.onAdmin} title="Instance admin — operator only">
            <Icon name="shield-check" cp437="ADM" className="lead-ic" />
          </Button>
        )}
        <Button onClick={props.onProfile} title="Profile — identity & advanced tools">
          <Icon name="profile" cp437="ME" className="lead-ic" />
        </Button>
      </span>
      <Button variant="primary" className="hide-cta" onClick={props.onHide}>
        + Hide a cache
      </Button>
    </header>
  );
}
