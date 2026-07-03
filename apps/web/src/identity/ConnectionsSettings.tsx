// SPDX-License-Identifier: AGPL-3.0-or-later
import { RfBrowser } from "../rf/RfBrowser.js";

/**
 * ConnectionsSettings — the user's OWN radio: the browser-direct RF bridge (Web Serial / BLE KISS), a
 * first-class operator-local ingest bound to this browser session (ingest-locality). This is per-user and
 * belongs in Settings. Instance-wide data-plane config (server ingest transports, the TAK/CoT feed) and
 * the federation network live in the operator-only Instance Admin surface, not here.
 */
export function ConnectionsSettings(props: { callsign: string; verified: boolean }) {
  return (
    <>
      <p className="muted">
        Bridge a USB/Bluetooth TNC in this browser to feed RF into the platform from your own station. This runs on your
        device (Chromium only) — nothing server-side.
      </p>
      <RfBrowser callsign={props.callsign} verified={props.verified} />
    </>
  );
}
