import { useEffect, useState } from "react";
import { toggleFavorite, type CacheDetail } from "../api.js";
import { typeMeta } from "../cacheTypes.js";
import { useFmt } from "../format.js";
import { Panel, Badge } from "../ui/index.js";
import { StagesSection } from "../log/StagesSection.js";
import { LogForm } from "../log/LogForm.js";

/** Cache detail + logbook — single primary action (Log a find); favourite + close recede. */
export function DetailPanel(props: {
  detail: CacheDetail; callsign: string; onClose: () => void; onLogged: () => void;
}) {
  const c = props.detail;
  const meta = typeMeta(c.type);
  const fmt = useFmt();
  const [fav, setFav] = useState({ on: c.favorited, count: c.favorites });
  useEffect(() => { setFav({ on: c.favorited, count: c.favorites }); }, [c.id, c.favorited, c.favorites]);
  async function toggleFav() {
    if (props.callsign.length < 3) return;
    const want = !fav.on;
    setFav((f) => ({ on: want, count: f.count + (want ? 1 : -1) })); // optimistic
    try { const r = await toggleFavorite(c.id, props.callsign, want); setFav(r); } catch { setFav({ on: c.favorited, count: c.favorites }); }
  }
  return (
    <Panel onClose={props.onClose}
      title={<><span className="dot" style={{ background: meta.color }} /> <span className="code">{c.code}</span></>}
      actions={<button className={`heart${fav.on ? " on" : ""}`} title="Favorite" onClick={toggleFav}>{fav.on ? "♥" : "♡"} {fav.count}</button>}>
      <h3>{c.title}</h3>
      <p className="muted">
        {meta.label} · D {c.difficulty.toFixed(1)} / T {c.terrain.toFixed(1)} · by {c.ownerCall}
        {c.minTrust && <> · requires tier {c.minTrust}</>}
      </p>
      {c.source !== "native" && (
        <p className="imported">
          ⤓ Imported from <strong>{c.sourceName ?? c.source}</strong>
          {c.sourceUrl && <> · <a href={c.sourceUrl} target="_blank" rel="noreferrer noopener">view source ↗</a></>}
        </p>
      )}
      <p><strong>{c.finds}</strong> verified find{c.finds === 1 ? "" : "s"}
        {c.status !== "active" && <> · <em>{c.status}</em></>}
        {c.needsMaintenance && <span className="warn"> · ⚠ needs maintenance</span>}</p>
      {c.description && <p>{c.description}</p>}
      {c.hint && <details><summary>Hint</summary><p>{c.hint}</p></details>}

      {c.stageCount > 0 && <StagesSection cacheId={c.id} callsign={props.callsign} />}

      <LogForm cacheId={c.id} cacheCode={c.code} callsign={props.callsign} onLogged={props.onLogged} />

      <h4>Logbook</h4>
      {c.logs.length === 0 && <p className="muted">No logs yet — be the first to find it.</p>}
      <ul className="logs">
        {c.logs.map((l) => (
          <li key={l.id}>
            <Badge kind={l.logType}>{l.logType}</Badge>
            <strong>{l.loggerCall}</strong>
            {l.logType === "found" && (
              l.verified
                ? <span className="ok">✓ tier {l.tier}</span>
                : <span className="muted">unverified{l.tier ? ` (tier ${l.tier})` : ""}</span>
            )}
            {l.corroboratedBy && <span className="muted"> · ⇄ via {l.corroboratedBy}</span>}
            <span className="muted"> · {fmt.date(l.ts)}</span>
            {l.comment && <div className="comment">{l.comment}</div>}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
