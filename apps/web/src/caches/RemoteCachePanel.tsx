// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CSSProperties } from "react";
import { typeMeta } from "../cacheTypes.js";
import { Panel, Badge } from "../ui/index.js";
import type { MapCache } from "../api.js";

/** A mirrored (peer-instance) cache — read-only; log on its home instance. */
export function RemoteCachePanel(props: { cache: MapCache; onClose: () => void }) {
  const c = props.cache;
  const meta = typeMeta(c.type);
  return (
    <Panel
      onClose={props.onClose}
      title={
        <>
          <span className="dot" style={{ ["--tc"]: meta.color } as CSSProperties} />{" "}
          <span className="code">{c.code}</span>
        </>
      }
    >
      <h3>{c.title}</h3>
      <p className="muted">
        {meta.label} · D {c.difficulty.toFixed(1)} / T {c.terrain.toFixed(1)} · by {c.ownerCall}
      </p>
      <p className="federated">
        ⇄ mirrored from <strong>{c.origin}</strong>
        {c.originTrust === "unvetted" && (
          <Badge kind="warn" title="From a peer you haven't vetted">
            unvetted
          </Badge>
        )}
      </p>
      <p className="muted">
        This cache lives on another instance in the network. Log your find on its home instance; it will appear here
        once that instance publishes it.
      </p>
    </Panel>
  );
}
