// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Spot } from "../api.js";
import { useFmt } from "../format.js";
import { Badge, useToast, Ico } from "../ui/index.js";
import { cat, useCatConnected } from "../rf/cat.js";

/**
 * SpotCard — the detail for a tapped live activity spot. A lightweight floating card
 * (spots are ephemeral), not a docked panel. Links to a coincident cache when one is nearby.
 */
export function SpotCard(props: { spot: Spot; onClose: () => void; onViewCache?: () => void }) {
  const fmt = useFmt();
  const toast = useToast();
  const rigOn = useCatConnected();
  const s = props.spot;
  const freqMHz = s.freqHz ? (s.freqHz / 1e6).toFixed(3) : null;
  async function tune() {
    try { await cat.tune(s.freqHz!, s.mode); toast(`Tuned to ${freqMHz} MHz`); }
    catch (e) { toast((e as Error).message); }
  }
  return (
    <div className="spot-card" role="group" aria-label={`Spot ${s.callsign}`}>
      <div className="spot-card-h">
        <span className="mono spot-call">{s.callsign}</span>
        <Badge className="ml-2">{s.source.toUpperCase()}</Badge>
        <span className="spacer" />
        <button className="icon" aria-label="Close" onClick={props.onClose}>✕</button>
      </div>
      {(s.ref || s.name) && <div className="spot-ref">{s.ref && <strong className="mono">{s.ref}</strong>}{s.name ? ` ${s.name}` : ""}</div>}
      <div className="spot-meta">
        {freqMHz && <Badge>{freqMHz} MHz</Badge>}
        {s.band && <Badge>{s.band}</Badge>}
        {s.mode && <Badge>{s.mode}</Badge>}
        <span className="muted">· spotted {fmt.ago(s.spottedAt)}</span>
      </div>
      {s.comment && <p className="spot-comment muted">{s.comment}</p>}
      {rigOn && s.freqHz != null && (
        <button className="spot-tune" onClick={tune} title="Tune your connected rig to this spot"><Ico e="📻 " />Tune rig to {freqMHz} MHz{s.mode ? ` ${s.mode}` : ""}</button>
      )}
      {props.onViewCache && (
        <button className="primary spot-cta" onClick={props.onViewCache}>This cache is being activated — open it →</button>
      )}
    </div>
  );
}
