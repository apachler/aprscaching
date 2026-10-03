// SPDX-License-Identifier: AGPL-3.0-or-later
import { Panel } from "../ui/index.js";
import { Watchlist } from "./Watchlist.js";

/** Alerts — the watchlist's alerts and the calls it watches, opened from the bell in the top bar. */
export function AlertsPanel(props: {
  callsign: string;
  onFly?: (lat: number, lon: number) => void;
  onClose: () => void;
}) {
  return (
    <Panel title="Alerts" onClose={props.onClose}>
      <Watchlist callsign={props.callsign} onFly={props.onFly} />
    </Panel>
  );
}
