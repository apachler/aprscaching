// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * TopBar — the cacher/operator top chrome: logo, type filter, search, in-view count, identity chip,
 * the tablet's nav (with the manual, which the rail and the phone's More sheet carry elsewhere) and the primary
 * "Hide a cache" action. The header is identical in every app mode —
 * switching into "hide" must not reshuffle the chrome. Reused by the app and the demo harness so the
 * teaser shows the same chrome everywhere (ui-ux §6: one component, no bespoke one-offs).
 */
import { ASSET, MANUAL_URL } from "./brand.js";
import { Button, Hint, Icon } from "./ui/index.js";
import { SearchSuggest } from "./search/SearchSuggest.js";
import { RadioChip } from "./rf/RadioChip.js";
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
  /** Open the search sheet: below 960px the bar shows a search button in place of the field. */
  onSearchOpen: () => void;
  onNearby: () => void;
  onActivity: () => void;
  onProfile: () => void;
  sysop?: boolean;
  onAdmin?: () => void;
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
      <span className="muted">
        · {props.count} {props.count === 1 ? "cache" : "caches"}
        {props.filtered ? " (filtered)" : " in view"}
      </span>
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
      <span className="nav-desktop">
        <Button onClick={props.onNearby}>Nearby</Button>
        <Button onClick={props.onActivity}>Activity</Button>
        {props.sysop && props.onAdmin && (
          <Button onClick={props.onAdmin} hint="Instance admin, for this instance's operator only" aria-label="Admin">
            <Icon name="shield-check" cp437="ADM" className="lead-ic" />
          </Button>
        )}
        <Button onClick={props.onProfile} hint="You: your profile, finds and callsigns" aria-label="You">
          <Icon name="profile" cp437="ME" className="lead-ic" />
        </Button>
        <Hint text="The user manual, on its own site">
          <a
            className="help-ic"
            href={MANUAL_URL}
            target="_blank"
            rel="noopener"
            aria-label="Manual (opens in a new tab)"
          >
            <Icon name="book" size={16} cp437="?" />
          </a>
        </Hint>
      </span>
      <Button variant="primary" className="hide-cta" onClick={props.onHide}>
        + Hide a cache
      </Button>
    </header>
  );
}
