// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import { getNodes, getMheard, type NodeRouteRow, type MheardRow } from "../api.js";
import { useFmt } from "../format.js";
import { ErrorState, Button } from "../ui/index.js";
import { useToolHost } from "../tools/host.js";
import { ToolPanels } from "../tools/ToolPanels.js";

/**
 * NodePanel — the read-only NET/ROM node view: the NODES routing table this node knows +
 * the per-port MHeard list (recently heard stations). Loaded on demand. The node CLI + advertising
 * NODES on RF run operator-local on the ingest; this surfaces the tables the gateway keeps.
 */
export function NodePanel() {
  const [open, setOpen] = useState(true);
  const [nodes, setNodes] = useState<NodeRouteRow[] | null>(null);
  const [mheard, setMheard] = useState<MheardRow[] | null>(null);
  const [loadErr, setLoadErr] = useState(false);
  const fmt = useFmt();
  const host = useToolHost(); // tools targeting the "node" surface

  useEffect(() => {
    if (!open || nodes) return;
    setLoadErr(false);
    getNodes()
      .then((r) => setNodes(r.nodes))
      .catch(() => setLoadErr(true));
    getMheard(30)
      .then((r) => setMheard(r.mheard))
      .catch(() => setLoadErr(true));
  }, [open, nodes]);

  const latest = mheard?.reduce((t, m) => Math.max(t, m.lastHeard), 0) ?? 0;
  return (
    <div className="node-panel">
      {nodes && mheard && (
        <p className="muted" role="status">
          {nodes.length || mheard.length
            ? `${nodes.length} node${nodes.length === 1 ? "" : "s"} learned · ${mheard.length} station${
                mheard.length === 1 ? "" : "s"
              } heard${latest ? ` · last heard ${fmt.ago(latest)}` : ""}`
            : "Nothing learned or heard yet: the node runs on the instance's ingest box, which reports its tables here."}
        </p>
      )}
      <Button
        variant="quiet"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        hint="The NET/ROM nodes this node has learned, and the stations it heard recently"
      >
        {open ? "▾" : "▸"} NODES + MHeard
      </Button>
      {open && loadErr && (
        <ErrorState
          onRetry={() => {
            setNodes(null);
            setMheard(null);
          }}
        >
          Couldn't load the node tables.
        </ErrorState>
      )}
      {open && !loadErr && (
        <div className="mt-1">
          <div className="ulabel">Nodes</div>
          {nodes == null ? (
            <p className="muted">Loading…</p>
          ) : nodes.length === 0 ? (
            <p className="muted">No NET/ROM nodes learned yet.</p>
          ) : (
            <ul className="logs">
              {nodes.map((n) => (
                <li key={n.dest}>
                  <span className="mono">
                    <strong>{n.alias}</strong>:{n.dest}
                  </span>{" "}
                  <span className="muted">
                    · via {n.neighbor} · q{n.quality}
                    {n.port ? ` · ${n.port}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="ulabel mt-2">MHeard</div>
          {mheard == null ? (
            <p className="muted">Loading…</p>
          ) : mheard.length === 0 ? (
            <p className="muted">Nothing heard yet.</p>
          ) : (
            <ul className="logs">
              {mheard.map((m) => (
                <li key={`${m.callsign}-${m.port}`}>
                  <span className="mono">{m.callsign}</span>{" "}
                  <span className="muted">
                    · {m.port} · {fmt.ago(m.lastHeard)} · ×{m.count}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <ToolPanels host={host} surface="node" />
    </div>
  );
}
