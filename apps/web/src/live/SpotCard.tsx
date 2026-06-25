import type { Spot } from "../api.js";
import { useFmt } from "../format.js";
import { Badge } from "../ui/index.js";

/**
 * SpotCard — the detail for a tapped live activity spot (docs/20 S2). A lightweight floating card
 * (spots are ephemeral), not a docked panel. Links to a coincident cache when one is nearby.
 */
export function SpotCard(props: { spot: Spot; onClose: () => void; onViewCache?: () => void }) {
  const fmt = useFmt();
  const s = props.spot;
  const freqMHz = s.freqHz ? (s.freqHz / 1e6).toFixed(3) : null;
  return (
    <div className="spot-card" role="dialog" aria-label={`Spot ${s.callsign}`}>
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
      {props.onViewCache && (
        <button className="primary spot-cta" onClick={props.onViewCache}>This cache is being activated — open it →</button>
      )}
    </div>
  );
}
