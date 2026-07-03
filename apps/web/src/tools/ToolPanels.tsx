// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CSSProperties } from "react";
import type { ToolHost, PanelNode, Surface } from "@aprsweb/tools";

/**
 * ToolPanels — the host-side renderer for `panel`-capability tools. A tool emits a declarative
 * PanelSpec (typed nodes, never DOM); this turns it into real semantic elements + theme tokens for the
 * given surface. Mounted on every surface that wants tool UI (Tools app = web, packet terminal, BBS,
 * node), it renders exactly the enabled tools whose declared `surfaces` include that surface.
 */
const toneClass = (t?: string): string => (t && t !== "default" ? ` tp-${t}` : "");

function Node({ n }: { n: PanelNode }) {
  switch (n.kind) {
    case "text":
      return <p className={`tp-text${toneClass(n.tone)}`}>{n.text}</p>;
    case "kv":
      return (
        <div className="tp-kv">
          <span className="tp-k">{n.key}</span>
          <span className={`tp-v${toneClass(n.tone)}`}>{n.value}</span>
        </div>
      );
    case "badge":
      return <span className={`badge${toneClass(n.tone)}`}>{n.text}</span>;
    case "bar": {
      const pct = Math.max(0, Math.min(100, (n.value / (n.max || 1)) * 100));
      return (
        <div className="tp-bar">
          <span className="tp-k">{n.label}</span>
          <span className="tp-track" role="progressbar" aria-valuenow={n.value} aria-valuemax={n.max}>
            <span className={`tp-fill${toneClass(n.tone)}`} style={{ width: `${pct}%` } as CSSProperties} />
          </span>
        </div>
      );
    }
    case "table":
      return (
        <table className="tp-table">
          <thead>
            <tr>
              {n.head.map((h, i) => (
                <th key={i}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {n.rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, ci) => (
                  <td key={ci}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "blocks":
      // CP437/ANSI cell grid (GP GIP). A monospace grid of spans; colour from the ANSI token when set.
      return (
        <div className="tp-blocks" style={{ "--tp-cols": n.cols } as CSSProperties} role="img" aria-label="block art">
          {n.cells.map((cell, i) => (
            <span key={i} style={cell.c != null ? ({ color: `var(--ansi-${cell.c})` } as CSSProperties) : undefined}>
              {cell.ch === " " ? " " : cell.ch}
            </span>
          ))}
        </div>
      );
    default:
      return null;
  }
}

export function ToolPanels({ host, surface }: { host: ToolHost; surface: Surface }) {
  const panels = host.panels(surface);
  if (panels.length === 0) return null;
  return (
    <div className="tool-panels">
      {panels.map((p) => (
        <section key={p.tool} className="tool-panel" aria-label={p.spec.title ?? p.title}>
          {p.spec.title && <h4 className="tool-panel-h">{p.spec.title}</h4>}
          {p.spec.nodes.map((n, i) => (
            <Node key={i} n={n} />
          ))}
        </section>
      ))}
    </div>
  );
}
