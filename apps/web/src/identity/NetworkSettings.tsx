import { useEffect, useState } from "react";
import { listFederationPeers, type FedPeer } from "../api.js";
import { useFmt } from "../format.js";
import { Badge, EmptyState } from "../ui/index.js";

/**
 * NetworkSettings — federation peers (the platform network): who this instance mirrors, their trust
 * tier, sync health and corroboration counts. Lives in Settings → "Network" (moved out of the
 * workbench). Read view; peer management is instance-config.
 */
export function NetworkSettings() {
  const fmt = useFmt();
  const [peers, setPeers] = useState<FedPeer[]>([]);
  useEffect(() => { listFederationPeers().then((r) => setPeers(r.peers)).catch(console.error); }, []);

  if (peers.length === 0) return <EmptyState>No federation peers configured.</EmptyState>;
  return (
    <ul className="logs">
      {peers.map((p) => (
        <li key={p.url}>
          <Badge kind={p.health === "ok" ? "found" : p.health === "error" ? "dnf" : "warn"} title={`trust: ${p.trust}`}>{p.health}</Badge>
          <span className="mono">{p.instance ?? p.url}</span>
          <span className="muted"> · {p.trust}{p.signed ? " · signed" : ""}</span>
          <div className="comment">
            {p.last_ok ? `synced ${fmt.ago(p.last_ok)}` : "never synced"} · {p.mirrored_total} mirrored
            {p.rep_confirmed > 0 && ` · ${p.rep_confirmed} corroborations`}
            {p.sync_err > 0 && ` · ${Math.round(p.errorRate * 100)}% errors`}
          </div>
          {p.health === "error" && p.last_error && <div className="comment error">{p.last_error}</div>}
        </li>
      ))}
    </ul>
  );
}
