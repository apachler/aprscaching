// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * TopBar — the cacher/operator top chrome: logo, type filter, search, in-view count, identity chip and the
 * primary "Hide a cache" action. The destinations live in the nav rail (from 681px) and the phone's tab bar. The
 * header is identical in every app mode — switching into "hide" must not reshuffle the chrome. Reused by the app and the demo harness so the
 * teaser shows the same chrome everywhere (ui-ux §6: one component, no bespoke one-offs).
 */
import { ASSET } from "./brand.js";
import { Button, Icon } from "./ui/index.js";
import { SearchSuggest } from "./search/SearchSuggest.js";
import { RadioChip } from "./rf/RadioChip.js";
import type { SearchHitCache, SearchHitStation } from "@aprscaching/shared";

export function TopBar(props: {
  callsign: string;
  verified: boolean;
  onAccount: () => void;
  onHide: () => void;
  /** Caches in view; null until the map has read them (no "0 caches" while it loads). */
  count: number | null;
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
  /** Open the search sheet: below 960px the bar shows a search button in place of the field. */
  onSearchOpen: () => void;
  /** Unseen watchlist alerts; the bell shows only when `onAlerts` is given (signed in). */
  alerts?: number;
  onAlerts?: () => void;
  /** Open the radio settings: the radio chip shows when this is given (signed in) and a radio is connected. */
  onRadio?: () => void;
}) {
  const alerts = props.alerts ?? 0;
  return (
    <header className="topbar">
      <img className="logo" src={ASSET.wordmark} alt="APRScaching" />
      <Button
        variant="icon"
        className={`filter-ic${props.filtered ? " on" : ""}`}
        onClick={props.onFilters}
        hint="Filter caches by type, difficulty and status"
        aria-label="Search and filter caches"
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
      <Button
        variant="icon"
        className="search-ic"
        onClick={props.onSearchOpen}
        hint="Search caches, stations or a grid locator"
        aria-haspopup="dialog"
      >
        <Icon name="search" size={16} />
      </Button>
      {props.count != null && (
        <span className="muted">
          · {props.count} {props.count === 1 ? "cache" : "caches"}
          {props.filtered ? " (filtered)" : " in view"}
        </span>
      )}
      {props.syncLine && (
        <Button
          variant="quiet"
          className={`queue-chip${props.attention > 0 ? " attn" : ""}`}
          onClick={props.onQueue}
          hint="Logs waiting to send and the areas saved for offline use"
        >
          <Icon name="offline" cp437="" className="lead-ic" />
          {props.syncLine}
        </Button>
      )}
      <span className="spacer" />
      {props.onRadio && <RadioChip onOpen={props.onRadio} />}
      {props.onAlerts && (
        <Button
          variant="icon"
          className="bell-ic"
          onClick={props.onAlerts}
          hint="Alerts from your watchlist"
          aria-label={alerts > 0 ? `Alerts, ${alerts} new` : "Alerts"}
        >
          <Icon name="bell" size={16} />
          {alerts > 0 && (
            <span className="bell-count" aria-hidden="true">
              {alerts > 99 ? "99+" : alerts}
            </span>
          )}
        </Button>
      )}
      <Button
        className={`idchip${props.verified ? " ok" : ""}`}
        onClick={props.onAccount}
        hint="Your account and callsigns"
      >
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
      <Button variant="primary" className="hide-cta" onClick={props.onHide}>
        + Hide a cache
      </Button>
    </header>
  );
}
