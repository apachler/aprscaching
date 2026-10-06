// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useState } from "react";
import { getLeaderboard, getProfile, type LeaderboardEntry, type Profile, type RankPeriod } from "../api.js";
import { useFmt } from "../format.js";
import { Panel, Badge, EmptyState, ErrorState, Button, Icon, Segmented, Hint, useToast } from "../ui/index.js";
import { usePlatform } from "../platform/PlatformContext.js";
import { badgeInfo } from "../profile/badges.js";
import { ContentMenu } from "../moderation/ContentMenu.js";

const PERIODS: { value: RankPeriod; label: string; empty: string }[] = [
  { value: "all", label: "All time", empty: "No verified finds in this area yet." },
  { value: "year", label: "Year", empty: "No verified finds in this area in the last 365 days." },
  { value: "month", label: "Month", empty: "No verified finds in this area in the last 30 days." },
];

/** Community — area leaderboard over a period, drill into a finder's profile. */
export function CommunityPanel(props: { onClose: () => void }) {
  const { map } = usePlatform();
  const fmt = useFmt();
  const [metric, setMetric] = useState<"points" | "finds">("points");
  const [period, setPeriod] = useState<RankPeriod>("all");
  const [rows, setRows] = useState<LeaderboardEntry[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(false);
  // a failed load is its own state: an outage must never read as "no finds here"
  const [failed, setFailed] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    const m = map;
    if (!m) return;
    const b = m.getBounds();
    setLoading(true);
    setFailed(false);
    try {
      setRows(
        (await getLeaderboard([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], metric, period)).leaderboard,
      );
    } catch {
      setRows([]);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [map, metric, period]);
  useEffect(() => {
    if (!profile) void load();
  }, [load, profile]);

  if (profile) {
    return (
      <Panel
        onClose={props.onClose}
        title={
          <>
            {profile.callsign}
            {profile.accountVerified && <span className="ok"> ✓</span>}
          </>
        }
      >
        <div className="row between">
          <Button onClick={() => setProfile(null)}>← Ranks</Button>
          <ContentMenu
            target={{ kind: "profile", id: profile.callsign, label: profile.callsign }}
            onRemoved={() => setProfile(null)}
          />
        </div>
        <p className="mt-5">
          <strong>{profile.finds}</strong> {profile.finds === 1 ? "find" : "finds"} · <strong>{profile.points}</strong>{" "}
          pts · {profile.hides} hidden
        </p>
        {profile.lastFind && <p className="muted">last find {fmt.date(profile.lastFind)}</p>}
        <h4>Badges</h4>
        {profile.badges.length ? (
          <div className="badges">
            {profile.badges.map((b) => {
              const info = badgeInfo(b.badge);
              const award = (
                <span key={b.badge} className="award">
                  {info.name}
                </span>
              );
              return info.how ? (
                <Hint key={b.badge} text={info.how}>
                  {award}
                </Hint>
              ) : (
                award
              );
            })}
          </div>
        ) : (
          <p className="muted">No badges yet.</p>
        )}
        <h4>Finds by type</h4>
        <div className="badges">
          {Object.entries(profile.byType).map(([t, n]) => (
            <Badge key={t}>
              {t}: {n}
            </Badge>
          ))}
        </div>
      </Panel>
    );
  }
  return (
    <Panel
      title={
        <>
          <Icon name="trophy" cp437="" className="lead-ic" />
          Ranks
        </>
      }
      onClose={props.onClose}
    >
      <Segmented
        label="Rank by"
        value={metric}
        onChange={setMetric}
        options={[
          { value: "points", label: "Points" },
          { value: "finds", label: "Finds" },
        ]}
      />
      <div className="row">
        <Segmented
          label="Period"
          value={period}
          onChange={setPeriod}
          options={PERIODS.map((p) => ({ value: p.value, label: p.label }))}
        />
        <span className="spacer" />
        <Button onClick={load}>↻ this area</Button>
      </div>
      {loading && <p className="muted">Loading…</p>}
      {!loading && failed && (
        <ErrorState onRetry={() => void load()}>
          Couldn&apos;t load the ranks — check your connection and retry.
        </ErrorState>
      )}
      {!loading && !failed && !rows.length && <EmptyState>{PERIODS.find((p) => p.value === period)?.empty}</EmptyState>}
      <ol className="board">
        {rows.map((r) => (
          <li key={r.loggerCall}>
            <span className="rank">{r.rank}</span>
            <Button
              variant="quiet"
              onClick={() =>
                getProfile(r.loggerCall)
                  .then(setProfile)
                  .catch(() => toast(`Couldn't load ${r.loggerCall}'s profile — try again`))
              }
            >
              {r.loggerCall}
            </Button>
            <span className="spacer" />
            <strong>{metric === "points" ? r.points : r.finds}</strong>
            <span className="muted">&nbsp;{metric === "points" ? "pts" : "finds"}</span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
