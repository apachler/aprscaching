// SPDX-License-Identifier: AGPL-3.0-or-later
import { typeMeta } from "../cacheTypes.js";
import { Panel, Badge, Button, Icon, copyText, useToast } from "../ui/index.js";
import type { MapCache } from "../api.js";
import { maidenhead } from "../map/geo.js";
import { NavigateCache } from "./NavigateCache.js";

/** The cache's page on its home instance: the share link every instance opens (`/?cache=`). */
function remoteCacheUrl(c: Pick<MapCache, "code" | "origin" | "originUrl">): string {
  const base = c.originUrl ?? `https://${c.origin}`;
  return `${base}/?cache=${encodeURIComponent(c.code)}`;
}

/**
 * A mirrored (peer-instance) cache — read-only here. Its heading names the home instance with the code, since
 * codes repeat across instances; the way on is its page there (where it is logged), its coordinates and Navigate.
 */
export function RemoteCachePanel(props: { cache: MapCache; onClose: () => void }) {
  const c = props.cache;
  const meta = typeMeta(c.type);
  const toast = useToast();
  const hasPlace = c.lat != null && c.lon != null;
  function copyCoords() {
    if (c.lat == null || c.lon == null) return;
    void copyText(`${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`).then((ok) =>
      toast(ok ? "Coordinates copied" : "Copy failed — long-press the coordinates to copy"),
    );
  }
  return (
    <Panel
      peek
      onClose={props.onClose}
      title={
        <>
          <span className="dot" data-ctype={c.type} aria-hidden="true" /> <span className="code">{c.code}</span>
          <span className="muted"> · {c.origin}</span>
        </>
      }
    >
      <h3>{c.title}</h3>
      <p className="muted">
        {meta.label} · D {c.difficulty.toFixed(1)} / T {c.terrain.toFixed(1)} · by {c.ownerCall}
      </p>
      <p className="federated">
        <Icon name="link" size={16} className="lead-ic" /> mirrored from <strong>{c.origin}</strong>
        {c.originTrust === "unvetted" && (
          <Badge kind="warn" title="This instance's sysop has not vetted the instance this cache comes from">
            unvetted
          </Badge>
        )}
      </p>
      <p className="muted">
        This cache lives on {c.origin}. Log your find there; it shows here once that instance publishes it.
      </p>
      <a className="remote-home" href={remoteCacheUrl(c)} target="_blank" rel="noreferrer noopener">
        Open {c.code} on {c.origin} ↗
      </a>
      {hasPlace && (
        <div className="coordblock mt-3">
          <div className="coordblock-h">
            <span className="ulabel">Coordinates</span>
            <Button variant="icon-subtle" aria-label="Copy coordinates" onClick={copyCoords}>
              <Icon name="copy" size={16} />
            </Button>
          </div>
          <div className="coordblock-g">
            <span className="k">LAT/LON</span>
            <span className="v">
              {c.lat!.toFixed(4)}° · {c.lon!.toFixed(4)}°
            </span>
            <span className="k">GRID</span>
            <span className="v">{maidenhead(c.lat!, c.lon!, 10)}</span>
          </div>
          <NavigateCache lat={c.lat!} lon={c.lon!} title={c.title} />
        </div>
      )}
    </Panel>
  );
}
