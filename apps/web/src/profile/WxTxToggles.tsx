// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { setWxTx } from "../api.js";
import { Switch } from "../ui/Switch.js";
import { useToast } from "../ui/index.js";

/**
 * Weather TX opt-in (docs/17 W2/W3): beacon the PWS reading to APRS-IS and/or relay it to CWOP/NOAA.
 * Gated like H5 — off by default, and only available on a control-verified callsign (when unverified
 * we show a one-line reason instead of dead controls, per ui-ux). Shared by the home -13 PWS and the
 * per-station weather panel; `stationId` targets a registry station.
 */
export function WxTxToggles(props: { stationId?: number; txIs?: boolean; txCwop?: boolean; verified?: boolean }) {
  const toast = useToast();
  const [txIs, setTxIs] = useState(!!props.txIs);
  const [txCwop, setTxCwop] = useState(!!props.txCwop);
  const [busy, setBusy] = useState(false);

  async function apply(next: { txIs: boolean; txCwop: boolean }) {
    const prev = { txIs, txCwop };
    setTxIs(next.txIs); setTxCwop(next.txCwop); setBusy(true);   // optimistic
    try {
      const r = await setWxTx({ stationId: props.stationId, ...next });
      setTxIs(r.txIs); setTxCwop(r.txCwop);
    } catch (e) { setTxIs(prev.txIs); setTxCwop(prev.txCwop); toast((e as Error).message); }
    finally { setBusy(false); }
  }

  if (!props.verified)
    return <p className="muted fine">Verify your callsign to beacon weather to APRS-IS or relay it to CWOP/NOAA.</p>;

  return (
    <div className="wx-tx">
      <div className="row between">
        <label>Beacon to APRS-IS <span className="muted block">Transmit your weather as a standard APRS report.</span></label>
        <Switch label="Beacon to APRS-IS" checked={txIs} disabled={busy} onChange={(v) => apply({ txIs: v, txCwop })} />
      </div>
      <div className="row between">
        <label>Relay to CWOP (NOAA) <span className="muted block">Feed your readings to NOAA's Citizen Weather network.</span></label>
        <Switch label="Relay to CWOP" checked={txCwop} disabled={busy} onChange={(v) => apply({ txIs, txCwop: v })} />
      </div>
    </div>
  );
}
