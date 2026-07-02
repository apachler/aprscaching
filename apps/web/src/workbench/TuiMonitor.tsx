import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type maplibregl from "maplibre-gl";
import { getStations, getSpots, getPorts, type BBox, type StationSummary, type Spot, type PortStat } from "../api.js";
import { useFmt, useTheme } from "../format.js";
import { roleMeta } from "../stationRoles.js";
import { aprsGlyph } from "../aprsGlyph.js";
import { toAnsi, cp437Bytes, type AnsiLine } from "@aprsweb/packet";

/** The live snapshot the HUD renders. Injectable (demo/tests) so the monitor screenshots without a gateway. */
export interface MonitorData { stations: StationSummary[]; spots: Spot[]; ports: PortStat[] }
interface LogEvent { ts: number; kind: "STN" | "SPOT"; text: string }

const MAX_ROWS = 14;       // rows per pane before the pane scrolls
const MAX_EVENTS = 200;    // rolling event-log cap
const DEFAULT_BBOX: BBox = [-13, 35, 30, 60]; // a broad EU window when there's no map (rarely hit)

/**
 * TuiMonitor (docs/24 §6.8 / T3) — the full-screen "all information at once" HUD, the purest Cogmind
 * expression. Fed by data we already serve (heard stations, live spots, port RX/TX), plus a rolling
 * event log built by diffing successive polls. Semantic tables + an aria-live log (not a `<pre>` that
 * breaks AT); the terminal look is pure CSS. Exports the log as a classic `.ans` (T3c).
 */
export function TuiMonitor(props: { callsign: string; map: maplibregl.Map | null; sample?: MonitorData }) {
  const fmt = useFmt();
  const cog = useTheme() === "cogmind";
  const [data, setData] = useState<MonitorData>(props.sample ?? { stations: [], spots: [], ports: [] });
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [err, setErr] = useState<string | null>(null);
  const seenStn = useRef(new Set<string>());
  const seenSpot = useRef(new Set<string>());

  // fold a fresh snapshot into state + append events for anything newly heard/spotted
  const ingest = useCallback((d: MonitorData) => {
    const ts = Math.floor(Date.now() / 1000);
    const fresh: LogEvent[] = [];
    for (const s of d.stations) if (!seenStn.current.has(s.callsign)) { seenStn.current.add(s.callsign); fresh.push({ ts, kind: "STN", text: `heard ${s.callsign}${s.comment ? ` · ${s.comment.slice(0, 28)}` : ""}` }); }
    for (const sp of d.spots) if (!seenSpot.current.has(sp.id)) { seenSpot.current.add(sp.id); fresh.push({ ts, kind: "SPOT", text: `spot ${sp.callsign}${sp.ref ? ` @ ${sp.ref}` : ""}${sp.mode ? ` ${sp.mode}` : ""}` }); }
    setData(d);
    if (fresh.length) setEvents((prev) => [...fresh.reverse(), ...prev].slice(0, MAX_EVENTS));
  }, []);

  // seed the event log from the injected sample once (demo/tests never poll)
  useEffect(() => { if (props.sample) ingest(props.sample); /* eslint-disable-next-line */ }, []);

  // live poll (skipped when a sample is injected). Bbox tracks the map; a broad default otherwise.
  useEffect(() => {
    if (props.sample) return;
    let live = true;
    const bboxNow = (): BBox => {
      const b = props.map?.getBounds();
      return b ? [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] : DEFAULT_BBOX;
    };
    const poll = async () => {
      try {
        const bbox = bboxNow();
        const [st, sp, po] = await Promise.all([
          getStations(bbox).catch(() => ({ stations: [] })),
          getSpots(bbox).catch(() => ({ spots: [] as Spot[] })),
          getPorts().catch(() => ({ ports: [] as PortStat[] })),
        ]);
        if (live) { setErr(null); ingest({ stations: st.stations, spots: sp.spots, ports: po.ports }); }
      } catch (e) { if (live) setErr((e as Error).message); }
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => { live = false; clearInterval(id); };
  }, [props.map, props.sample, ingest]);

  // Zulu clock — ticks each second (cheap; not motion). Skipped for the injected sample so screenshots are stable.
  useEffect(() => {
    if (props.sample) return;
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [props.sample]);

  const stations = useMemo(() => [...data.stations].sort((a, b) => b.lastSeen - a.lastSeen), [data.stations]);
  const spots = useMemo(() => [...data.spots].sort((a, b) => b.spottedAt - a.spottedAt), [data.spots]);
  const zulu = new Date(now * 1000).toISOString().slice(11, 16) + "Z";
  const glyphFor = (s: StationSummary): string => {
    const role = roleMeta(s.roles); if (role) return cog ? role.cog : role.glyph;
    const a = aprsGlyph(s.symbol); return a ? (cog ? a.cog : a.glyph) : "•";
  };
  const maxRx = Math.max(1, ...data.ports.map((p) => Math.max(p.rx, p.tx)));
  const bar = (n: number, max: number, width = 14): string => {
    const on = Math.round((n / max) * width);
    return "█".repeat(on) + "░".repeat(Math.max(0, width - on));
  };

  // Serialise the current HUD to a colour .ans and download it (T3c). Phosphor green base, cyan heads.
  function exportAns() {
    const HEAD = 14, DIM = 7, GREEN = 10;
    const lines: AnsiLine[] = [];
    lines.push([{ text: `APRScaching TUI monitor  ${zulu}  STN ${stations.length}  SPOT ${spots.length}`, fg: HEAD, bold: true }]);
    lines.push("");
    lines.push([{ text: "STATIONS", fg: HEAD, bold: true }]);
    for (const s of stations.slice(0, 40)) lines.push([{ text: `  ${glyphFor(s)} `, fg: GREEN }, { text: s.callsign.padEnd(10), fg: GREEN }, { text: `${fmt.ago(s.lastSeen)}`, fg: DIM }]);
    lines.push("");
    lines.push([{ text: "SPOTS", fg: HEAD, bold: true }]);
    for (const sp of spots.slice(0, 40)) lines.push([{ text: `  ${sp.callsign.padEnd(10)}`, fg: GREEN }, { text: `${sp.ref ?? ""} ${sp.mode ?? ""}`, fg: DIM }]);
    lines.push("");
    lines.push([{ text: "EVENT LOG", fg: HEAD, bold: true }]);
    for (const e of events.slice(0, 60)) lines.push([{ text: `  [${new Date(e.ts * 1000).toISOString().slice(11, 19)}] `, fg: DIM }, { text: `${e.kind} `, fg: HEAD }, { text: e.text, fg: GREEN }]);
    const bytes = cp437Bytes(toAnsi(lines, { fg: GREEN }));
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
    const a = document.createElement("a"); a.href = url; a.download = `aprscaching-monitor-${zulu.replace(":", "")}.ans`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="tui">
      <div className="tui-hud">
        <span className="tui-hud-l">
          <strong>MONITOR</strong>
          <span className="tui-kv">STN <b>{stations.length}</b></span>
          <span className="tui-kv">SPOT <b>{spots.length}</b></span>
          <span className="tui-kv">PORT <b>{data.ports.length}</b></span>
          {err && <span className="tui-kv err">RX ERROR</span>}
        </span>
        <span className="spacer" />
        <span className="tui-clock mono">{zulu}</span>
        <button className="tui-export" onClick={exportAns} title="Download the log as ANSI art (.ans)">↓ .ans</button>
      </div>

      <div className="tui-grid">
        <section className="tui-pane" aria-label="Heard stations">
          <h3>STATIONS</h3>
          {stations.length === 0 ? <p className="tui-empty">no stations heard in view</p> : (
            <table className="tui-tbl"><thead><tr><th></th><th>CALL</th><th>AGE</th><th>SPD</th></tr></thead>
              <tbody>{stations.slice(0, MAX_ROWS).map((s) => (
                <tr key={s.callsign}><td className="tui-gly">{glyphFor(s)}</td><td className="mono">{s.callsign}</td>
                  <td className="tui-dim">{fmt.ago(s.lastSeen)}</td><td className="tui-dim">{s.speedKn ? fmt.speed(s.speedKn) : "—"}</td></tr>
              ))}</tbody></table>
          )}
        </section>

        <section className="tui-pane" aria-label="Live spots">
          <h3>SPOTS</h3>
          {spots.length === 0 ? <p className="tui-empty">no activity spots in view</p> : (
            <table className="tui-tbl"><thead><tr><th>CALL</th><th>REF</th><th>MODE</th><th>SRC</th></tr></thead>
              <tbody>{spots.slice(0, MAX_ROWS).map((sp) => (
                <tr key={sp.id}><td className="mono">{sp.callsign}</td><td className="tui-dim">{sp.ref ?? "—"}</td>
                  <td className="tui-dim">{sp.mode ?? "—"}</td><td className="tui-dim">{sp.source}</td></tr>
              ))}</tbody></table>
          )}
        </section>

        <section className="tui-pane" aria-label="Port signal levels">
          <h3>SIGNAL · RX/TX</h3>
          {data.ports.length === 0 ? <p className="tui-empty">no server ports — browser-direct / IS feed</p> : (
            <ul className="tui-bars">{data.ports.map((p) => (
              <li key={p.port}><span className="mono tui-port">{p.port}</span>
                <span className="tui-bar" aria-hidden="true">{bar(p.rx, maxRx)}</span>
                <span className="tui-dim">RX {p.rx} · TX {p.tx}</span></li>
            ))}</ul>
          )}
        </section>

        <section className="tui-pane tui-log" aria-label="Event log">
          <h3>EVENT LOG</h3>
          <ul className="tui-events" aria-live="polite">
            {events.length === 0 ? <li className="tui-empty">waiting for traffic…</li> :
              events.slice(0, 40).map((e, i) => (
                <li key={`${e.ts}-${i}`}>
                  <span className="tui-dim">[{new Date(e.ts * 1000).toISOString().slice(11, 19)}]</span>{" "}
                  <span className="tui-tag">{e.kind}</span> {e.text}
                </li>
              ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
