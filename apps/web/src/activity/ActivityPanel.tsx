import { useEffect, useState } from "react";
import maplibregl from "maplibre-gl";
import { getActivity, getLeaderboard, type ActivityItem, type LeaderboardEntry, type BBox } from "../api.js";
import { useFmt } from "../format.js";
import { Panel, Badge, EmptyState } from "../ui/index.js";

/** Activity — recent finds feed + a glance at the top finders (full board one tap away). */
export function ActivityPanel(props: { map: maplibregl.Map | null; onBoard: () => void; onClose: () => void }) {
  const fmt = useFmt();
  const [feed, setFeed] = useState<ActivityItem[]>([]);
  const [top, setTop] = useState<LeaderboardEntry[]>([]);
  useEffect(() => {
    const m = props.map; const bbox = m ? [m.getBounds().getWest(), m.getBounds().getSouth(), m.getBounds().getEast(), m.getBounds().getNorth()] as BBox : undefined;
    getActivity(bbox).then((r) => setFeed(r.activity)).catch(console.error);
    getLeaderboard(bbox ?? [-180, -90, 180, 90], "points").then((r) => setTop(r.leaderboard.slice(0, 5))).catch(console.error);
  }, [props.map]);
  return (
    <Panel title="Activity" onClose={props.onClose}>
      <h4>Recent finds</h4>
      {feed.length === 0 ? <EmptyState>No recent activity here — be the first to log a find.</EmptyState> : (
        <ul className="logs">
          {feed.map((a) => (
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
      <div className="row between"><h4>Top finders</h4><button className="link" onClick={props.onBoard}>full leaderboard →</button></div>
      <ol className="board">
        {top.map((e) => (
          <li key={e.loggerCall}><span className="rank">{e.rank}</span>
            <span className="mono flex-1">{e.loggerCall}</span><strong>{e.points}</strong>&nbsp;<span className="muted">pts</span></li>
        ))}
      </ol>
    </Panel>
  );
}
