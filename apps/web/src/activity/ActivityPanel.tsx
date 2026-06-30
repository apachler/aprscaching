import { useEffect, useMemo, useState } from "react";
import maplibregl from "maplibre-gl";
import { getActivity, getLeaderboard, getCorroborators, type LeaderboardEntry, type Corroborator, type BBox } from "../api.js";
import { useFmt } from "../format.js";
import { Panel, Badge, EmptyState, LoadMore, usePaged } from "../ui/index.js";

/** Activity — recent finds feed + a glance at the top finders (full board one tap away). */
export function ActivityPanel(props: { map: maplibregl.Map | null; onBoard: () => void; onClose: () => void }) {
  const fmt = useFmt();
  const [top, setTop] = useState<LeaderboardEntry[]>([]);
  const [corr, setCorr] = useState<Corroborator[]>([]);
  // snapshot the viewport once per open so paging stays anchored to a stable bbox
  const bbox = useMemo<BBox | undefined>(() => {
    const m = props.map; if (!m) return undefined;
    const b = m.getBounds(); return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  }, [props.map]);
  const feed = usePaged((cursor) => getActivity(bbox, cursor).then((r) => ({ items: r.activity, nextCursor: r.nextCursor, hasMore: r.hasMore })), [bbox]);
  useEffect(() => {
    getLeaderboard(bbox ?? [-180, -90, 180, 90], "points").then((r) => setTop(r.leaderboard.slice(0, 5))).catch(console.error);
    getCorroborators(bbox).then((r) => setCorr(r.corroborators.slice(0, 5))).catch(console.error);
  }, [bbox]);
  return (
    <Panel title="Activity" onClose={props.onClose}>
      <h4>Recent finds</h4>
      {feed.items.length === 0 ? <EmptyState>No recent activity here — be the first to log a find.</EmptyState> : (
        <ul className="logs">
          {feed.items.map((a) => (
            <li key={a.id}>
              {a.logType === "found" && a.verified
                ? <Badge kind={`tier${a.tier ?? "C"}`}>{a.tier === "A" ? "RF" : a.tier === "B" ? "App" : "✓"}</Badge>
                : <Badge kind={a.logType}>{a.logType}</Badge>}
              <strong className="mono">{a.loggerCall}</strong> <span className="muted">found</span> <span className="mono">{a.cacheCode}</span>
              <span className="muted"> · {fmt.ago(a.ts)}</span>
            </li>
          ))}
        </ul>
      )}
      <LoadMore hasMore={feed.hasMore} loading={feed.loading} onClick={feed.loadMore} />
      <div className="row between"><h4>Top finders</h4><button className="link" onClick={props.onBoard}>full leaderboard →</button></div>
      <ol className="board">
        {top.map((e) => (
          <li key={e.loggerCall}><span className="rank">{e.rank}</span>
            <span className="mono flex-1">{e.loggerCall}</span><strong>{e.points}</strong>&nbsp;<span className="muted">pts</span></li>
        ))}
      </ol>

      {corr.length > 0 && <>
        <div className="row between"><h4>Top corroborators</h4></div>
        <p className="muted fine">IGates whose RF helped verify finds to Tier A — infrastructure that feeds the commons.</p>
        <ol className="board">
          {corr.map((c) => (
            <li key={c.igate}><span className="rank">{c.rank}</span>
              <span className="mono flex-1">{c.igate}</span><strong>{c.corroborations}</strong>&nbsp;<span className="muted">✓</span></li>
          ))}
        </ol>
      </>}
    </Panel>
  );
}
