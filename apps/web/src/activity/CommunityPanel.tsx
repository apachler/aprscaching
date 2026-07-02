import { useCallback, useEffect, useState } from "react";
import maplibregl from "maplibre-gl";
import { getLeaderboard, getProfile, type LeaderboardEntry, type Profile } from "../api.js";
import { useFmt } from "../format.js";
import { Panel, Badge, EmptyState, Ico } from "../ui/index.js";

/** Community — area leaderboard, drill into a finder's profile. */
export function CommunityPanel(props: { map: maplibregl.Map | null; onClose: () => void }) {
  const fmt = useFmt();
  const [metric, setMetric] = useState<"points" | "finds">("points");
  const [rows, setRows] = useState<LeaderboardEntry[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    const m = props.map; if (!m) return;
    const b = m.getBounds();
    setLoading(true);
    try { setRows((await getLeaderboard([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], metric)).leaderboard); }
    catch (e) { console.error(e); } finally { setLoading(false); }
  }, [props.map, metric]);
  useEffect(() => { if (!profile) void load(); }, [load, profile]);

  if (profile) {
    return (
      <Panel onClose={props.onClose}
        title={<>{profile.callsign}{profile.accountVerified && <span className="ok"> ✓</span>}</>}>
        <button onClick={() => setProfile(null)}>← leaderboard</button>
        <p className="mt-4"><strong>{profile.finds}</strong> finds · <strong>{profile.points}</strong> pts · {profile.hides} hidden</p>
        {profile.lastFind && <p className="muted">last find {fmt.date(profile.lastFind)}</p>}
        <h4>Badges</h4>
        {profile.badges.length
          ? <div className="badges">{profile.badges.map((b) => <span key={b.badge} className="award">{b.badge}</span>)}</div>
          : <p className="muted">No badges yet.</p>}
        <h4>Finds by type</h4>
        <div className="badges">{Object.entries(profile.byType).map(([t, n]) => <Badge key={t}>{t}: {n}</Badge>)}</div>
      </Panel>
    );
  }
  return (
    <Panel title={<><Ico e="🏆 " />Leaderboard</>} onClose={props.onClose}>
      <div className="row">
        <button className={metric === "points" ? "primary" : ""} onClick={() => setMetric("points")}>Points</button>
        <button className={metric === "finds" ? "primary" : ""} onClick={() => setMetric("finds")}>Finds</button>
        <span className="spacer" /><button onClick={load}>↻ this area</button>
      </div>
      {loading && <p className="muted">Loading…</p>}
      {!loading && !rows.length && <EmptyState>No verified finds in this area yet.</EmptyState>}
      <ol className="board">
        {rows.map((r) => (
          <li key={r.loggerCall}>
            <span className="rank">{r.rank}</span>
            <button className="link" onClick={() => getProfile(r.loggerCall).then(setProfile).catch(console.error)}>{r.loggerCall}</button>
            <span className="spacer" />
            <strong>{metric === "points" ? r.points : r.finds}</strong>
            <span className="muted">&nbsp;{metric === "points" ? "pts" : "finds"}</span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
