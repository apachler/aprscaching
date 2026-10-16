// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TourName } from "../deeplink.js";
import { Button } from "../ui/index.js";

/**
 * The strip a public tour runs under: it says the app is on demo data and nothing is kept or sent, brings the steps
 * back, and leaves for the real app. Both exits are full page loads, so the tour's demo state goes with it.
 */
export function TourBanner(props: { tour: TourName; onReplay: () => void }) {
  return (
    <aside className="tour-banner" aria-label="Tour">
      <p>
        <strong>{props.tour === "game" ? "Game tour" : "Shack tour"}</strong> on demo data: nothing you do here is kept,
        sent or transmitted.
      </p>
      <span className="tour-banner-actions">
        <Button variant="quiet" onClick={props.onReplay}>
          Steps
        </Button>
        <a href="/">Leave the tour</a>
        <a className="tour-banner-join" href="/join">
          Join
        </a>
      </span>
    </aside>
  );
}
