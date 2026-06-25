import { SURFACES, SURFACE_GROUPS, FEEDS, userFeedPath, type SurfaceGroup } from "@aprsweb/shared";
import { API_BASE } from "./api.js";
import { Panel, Badge } from "./ui/index.js";

/**
 * Site map — every page and tool in one place, rendered from the shared SURFACES manifest (the same
 * source of truth behind `/sitemap.xml` and `/api/sitemap`). Rows navigate in-app; the Feeds section
 * links to the RSS feeds. Adding a surface to the manifest lists it here automatically.
 */
export function SiteMapPanel(props: { callsign: string; onNavigate: (key: string) => void; onClose: () => void }) {
  const feedHref = (path: string) => `${API_BASE}${path}`;
  return (
    <Panel title="Site map" onClose={props.onClose}>
      <p className="muted">Every page and tool on aprscaching. Tap a row to open it.</p>

      {SURFACE_GROUPS.map((group: SurfaceGroup) => {
        const items = SURFACES.filter((s) => s.group === group);
        if (!items.length) return null;
        return (
          <section className="group" key={group}>
            <header className="group-h"><span className="group-status">{group}</span></header>
            <ul className="logs sitemap-list">
              {items.map((s) => (
                <li key={s.key}>
                  <button className="link sitemap-row" onClick={() => props.onNavigate(s.key)}>
                    <strong>{s.title}</strong>
                    {s.access === "account" && <Badge className="ml-2">account</Badge>}
                    <div className="comment muted">{s.summary}</div>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      <section className="group">
        <header className="group-h"><span className="group-status">Feeds (RSS)</span></header>
        <ul className="logs sitemap-list">
          {FEEDS.map((f) => (
            <li key={f.key}>
              <a className="link sitemap-row" href={feedHref(f.path)} target="_blank" rel="noreferrer">
                <strong>{f.title}</strong> <Badge className="ml-2">RSS</Badge>
                <div className="comment muted">{f.summary}</div>
              </a>
            </li>
          ))}
          {props.callsign.length >= 3 && (
            <li>
              <a className="link sitemap-row" href={feedHref(userFeedPath(props.callsign))} target="_blank" rel="noreferrer">
                <strong>Your feed — <span className="mono">{props.callsign}</span></strong> <Badge className="ml-2">RSS</Badge>
                <div className="comment muted">Your finds, badge awards and scoring.</div>
              </a>
            </li>
          )}
        </ul>
      </section>

      <p className="muted">
        Machine-readable: <a className="link" href={feedHref("/sitemap.xml")} target="_blank" rel="noreferrer">sitemap.xml</a>
        {" · "}<a className="link" href={feedHref("/api/sitemap")} target="_blank" rel="noreferrer">/api/sitemap</a>
      </p>
    </Panel>
  );
}
