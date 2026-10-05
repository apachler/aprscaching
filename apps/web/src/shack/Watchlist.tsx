// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { listWatch, addWatch, removeWatch, getWatchAlerts, markWatchSeen, type WatchEntry } from "../api.js";
import { useFmt } from "../format.js";
import {
  Row,
  Badge,
  EmptyState,
  ErrorState,
  LoadMore,
  usePaged,
  useToast,
  useLoad,
  usePoll,
  Button,
} from "../ui/index.js";

/**
 * Watchlist — watch callsigns and see in-app alerts when one is heard, especially near a
 * cache. Per-account; the alert generation lives at ingest, this is the read/manage surface.
 */
export function Watchlist(props: { callsign: string; onFly?: (lat: number, lon: number) => void }) {
  const fmt = useFmt();
  const toast = useToast();
  const [input, setInput] = useState("");
  const signedIn = props.callsign.length >= 3;

  // Poll the lightweight summary (chips + unseen badge); the alerts list itself pages on demand so
  // "Load older" pages aren't clobbered by the interval.
  const summary = useLoad(() => (signedIn ? listWatch() : Promise.resolve(undefined)), [signedIn]);
  const loadSummary = summary.reload;
  usePoll(loadSummary, 15000, { enabled: signedIn, immediate: false });
  const watching: WatchEntry[] = summary.data?.watching ?? [];
  const unseen = summary.data?.unseen ?? 0;

  const alerts = usePaged(
    (cursor) => getWatchAlerts(cursor).then((r) => ({ items: r.alerts, nextCursor: r.nextCursor, hasMore: r.hasMore })),
    [signedIn],
  );

  async function add() {
    const cs = input.trim().toUpperCase();
    if (!cs) return;
    try {
      await addWatch(cs);
      setInput("");
      loadSummary();
    } catch (e) {
      toast((e as Error).message);
    }
  }
  async function remove(cs: string) {
    await removeWatch(cs).catch(() => {});
    loadSummary();
  }
  async function clearSeen() {
    await markWatchSeen().catch(() => {});
    summary.setData((d) => (d ? { ...d, unseen: 0 } : d));
    alerts.reload();
  }

  if (!signedIn) return <p className="muted">Sign in to watch callsigns.</p>;
  return (
    <>
      <p className="muted">Get an in-app alert when a watched callsign is heard — especially near a cache.</p>
      <Row label="Watch a callsign">
        <div className="row gap-2">
          <input
            className="mono field-sm"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="OE3ABC"
            aria-label="Callsign to watch"
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
          />
          <Button onClick={add} disabled={!input.trim()}>
            Watch
          </Button>
        </div>
      </Row>
      {watching.length === 0 ? (
        <EmptyState>Not watching anyone yet.</EmptyState>
      ) : (
        <div className="badges">
          {watching.map((w) => (
            <Button
              key={w.callsign}
              className="chip-btn"
              onClick={() => remove(w.callsign)}
              hint="Remove from watchlist"
              aria-label={`Stop watching ${w.callsign}`}
            >
              {w.callsign} ✕
            </Button>
          ))}
        </div>
      )}

      <div className="row between">
        <h4>Alerts{unseen > 0 ? ` (${unseen} new)` : ""}</h4>
        {unseen > 0 && (
          <Button variant="quiet" onClick={clearSeen}>
            Mark all seen
          </Button>
        )}
      </div>
      {alerts.error && alerts.items.length === 0 ? (
        <ErrorState onRetry={alerts.reload} />
      ) : alerts.items.length === 0 ? (
        <EmptyState>No alerts yet.</EmptyState>
      ) : (
        <ul className="logs">
          {alerts.items.map((a) => (
            <li key={a.id} className={a.seen ? "" : "unseen"}>
              <Badge
                kind={
                  a.kind === "corroborated" || a.kind === "near_cache"
                    ? "tierA"
                    : a.kind === "cache_found"
                      ? "tierB"
                      : "tierC"
                }
              >
                {a.kind === "corroborated"
                  ? "you corroborated"
                  : a.kind === "cache_found"
                    ? "found your cache"
                    : a.kind === "near_cache"
                      ? "near cache"
                      : "heard"}
              </Badge>
              <strong className="mono"> {a.callsign}</strong>
              <span className="muted"> · {fmt.ago(a.ts)}</span>
              {a.detail && <div className="comment">{a.detail}</div>}{" "}
              {a.lat != null && a.lon != null && props.onFly && (
                <Button variant="quiet" onClick={() => props.onFly!(a.lat!, a.lon!)}>
                  show on map
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <LoadMore hasMore={alerts.hasMore} loading={alerts.loading} onClick={alerts.loadMore} label="Load older alerts" />
    </>
  );
}
