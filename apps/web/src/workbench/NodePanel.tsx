// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import { getNodes, getMheard, type NodeRouteRow, type MheardRow } from "../api.js";
import { useFmt } from "../format.js";
import { useToolHost } from "../tools/host.js";
import { ToolPanels } from "../tools/ToolPanels.js";

/**
 * NodePanel (docs/design/25 P4) — the read-only NET/ROM node view: the NODES routing table this node knows +
 * the per-port MHeard list (recently heard stations). Loaded on demand. The node CLI + advertising
 * NODES on RF run operator-local on the ingest; this surfaces the tables the gateway keeps.
 */
export function NodePanel() {
  const [open, setOpen] = useState(false);
  const [nodes, setNodes] = useState<NodeRouteRow[] | null>(null);
  const [mheard, setMheard] = useState<MheardRow[] | null>(null);
  const fmt = useFmt();
  const host = useToolHost(); // tools targeting the "node" surface

  useEffect(() => {
    if (!open || nodes) return;
    getNodes().then((r) => setNodes(r.nodes)).catch(() => setNodes([]));
    getMheard(30).then((r) => setMheard(r.mheard)).catch(() => setMheard([]));
  }, [open, nodes]);

  return (
    <div className="node-panel">
      <button className="link" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? "▾" : "▸"} NODES + MHeard
      </button>
      {open && (
        <div className="mt-1">
          <div className="ulabel">Nodes</div>
          {nodes == null ? <p className="muted">Loading…</p>
            : nodes.length === 0 ? <p className="muted">No NET/ROM nodes learned yet.</p>
            : <ul className="logs">{nodes.map((n) => (
                <li key={n.dest}><span className="mono"><strong>{n.alias}</strong>:{n.dest}</span> <span className="muted">· via {n.neighbor} · q{n.quality}{n.port ? ` · ${n.port}` : ""}</span></li>
              ))}</ul>}
          <div className="ulabel mt-2">MHeard</div>
          {mheard == null ? <p className="muted">Loading…</p>
            : mheard.length === 0 ? <p className="muted">Nothing heard yet.</p>
            : <ul className="logs">{mheard.map((m) => (
                <li key={`${m.callsign}-${m.port}`}><span className="mono">{m.callsign}</span> <span className="muted">· {m.port} · {fmt.ago(m.lastHeard)} · ×{m.count}</span></li>
              ))}</ul>}
        </div>
      )}
      <ToolPanels host={host} surface="node" />
    </div>
  );
}
