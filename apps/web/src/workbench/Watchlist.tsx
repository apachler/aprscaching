import { useCallback, useEffect, useState } from "react";
import { listWatch, addWatch, removeWatch, getWatchAlerts, markWatchSeen, type WatchEntry } from "../api.js";
import { useFmt } from "../format.js";
import { Row, Badge, EmptyState, LoadMore, usePaged, useToast } from "../ui/index.js";

/**
 * Watchlist (docs/20 W1) — watch callsigns and see in-app alerts when one is heard, especially near a
 * cache. Per-account; the alert generation lives at ingest, this is the read/manage surface.
 */
export function Watchlist(props: { callsign: string; onFly?: (lat: number, lon: number) => void }) {
  const fmt = useFmt();
  const toast = useToast();
  const [watching, setWatching] = useState<WatchEntry[]>([]);
  const [unseen, setUnseen] = useState(0);
  const [input, setInput] = useState("");
  const signedIn = props.callsign.length >= 3;

  // Poll the lightweight summary (chips + unseen badge); the alerts list itself pages on demand so
  // "Load older" pages aren't clobbered by the interval.
  const loadSummary = useCallback(() => {
    if (!signedIn) return;
    listWatch().then((r) => { setWatching(r.watching); setUnseen(r.unseen); }).catch(() => {});
  }, [signedIn]);
  useEffect(() => { loadSummary(); const t = setInterval(loadSummary, 15000); return () => clearInterval(t); }, [loadSummary]);

  const alerts = usePaged((cursor) => getWatchAlerts(cursor).then((r) => ({ items: r.alerts, nextCursor: r.nextCursor, hasMore: r.hasMore })), [signedIn]);

  async function add() {
    const cs = input.trim().toUpperCase();
    if (!cs) return;
    try { await addWatch(cs); setInput(""); loadSummary(); } catch (e) { toast((e as Error).message); }
  }
  async function remove(cs: string) { await removeWatch(cs).catch(() => {}); loadSummary(); }
  async function clearSeen() { await markWatchSeen().catch(() => {}); setUnseen(0); alerts.reload(); }

  if (!signedIn) return <p className="muted">Sign in to watch callsigns.</p>
  return (
    <>
      <p className="muted">Get an in-app alert when a watched callsign is heard — especially near a cache.</p>
      <Row label="Watch a callsign">
        <div className="row gap-2">
          <input className="mono field-sm" value={input} onChange={(e) => setInput(e.target.value)} placeholder="OE3ABC"
                 aria-label="Callsign to watch" onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
          <button onClick={add} disabled={!input.trim()}>Watch</button>
        </div>
      </Row>
      {watching.length === 0
        ? <EmptyState>Not watching anyone yet.</EmptyState>
        : <div className="badges">{watching.map((w) => (
            <button key={w.callsign} className="chip-btn" onClick={() => remove(w.callsign)} title="Remove from watchlist">{w.callsign} ✕</button>
          ))}</div>}

      <div className="row between"><h4>Alerts{unseen > 0 ? ` (${unseen} new)` : ""}</h4>{unseen > 0 && <button className="link" onClick={clearSeen}>mark all seen</button>}</div>
      {alerts.items.length === 0
        ? <EmptyState>No alerts yet.</EmptyState>
        : <ul className="logs">{alerts.items.map((a) => (
            <li key={a.id} className={a.seen ? "" : "unseen"}>
              <Badge kind={a.kind === "near_cache" ? "tierA" : "tierC"}>{a.kind === "near_cache" ? "near cache" : "heard"}</Badge>
              <strong className="mono"> {a.callsign}</strong>
              <span className="muted"> · {fmt.ago(a.ts)}</span>
              {a.detail && <div className="comment">{a.detail}</div>}
              {a.lat != null && a.lon != null && props.onFly && (
                <button className="link" onClick={() => props.onFly!(a.lat!, a.lon!)}>show on map</button>
              )}
            </li>
          ))}</ul>}
      <LoadMore hasMore={alerts.hasMore} loading={alerts.loading} onClick={alerts.loadMore} label="Load older alerts" />
    </>
  );
}
