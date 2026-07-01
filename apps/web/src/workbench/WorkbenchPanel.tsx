import { useEffect, useState } from "react";
import maplibregl from "maplibre-gl";
import {
  getPorts, getMessages, cotUrl, getStation, decodePacket, listFederationPeers, createStation,
  type DecodedPacket, type StationDetail, type PortStat, type FedPeer,
} from "../api.js";
import { ROLE_META } from "../stationRoles.js";
import type { StationRole } from "@aprsweb/shared";
import { useFmt } from "../format.js";
import { Panel, Group, Row, Badge, EmptyState, LoadMore, usePaged, useToast, Icon } from "../ui/index.js";
import type { WorkbenchApp, WorkbenchAppId } from "./apps.js";
import { RemoteControl } from "./RemoteControl.js";
import { Watchlist } from "./Watchlist.js";
import { RfBrowser } from "../rf/RfBrowser.js";
import { NodePanel } from "./NodePanel.js";
import { ToolsPanel } from "../tools/ToolsPanel.js";
import { TrackReplay } from "./TrackReplay.js";
import { StationGraphs } from "./StationGraphs.js";
import { StationPackets } from "./StationPackets.js";
import { RigControl } from "./RigControl.js";

/** Workbench — the full APRS toolset, grouped; switch on only what you need. */
export function WorkbenchPanel(props: {
  onClose: () => void; map: maplibregl.Map | null; callsign: string; verified: boolean;
  stationsOn: boolean; setStationsOn: (v: boolean) => void; stationCount: number;
  picked: string | null; onPick: (cs: string | null) => void; onFly: (lat: number, lon: number) => void;
  onOpenTerminal: () => void;
  apps: WorkbenchApp[]; pinned: WorkbenchAppId[]; onLaunchApp: (id: WorkbenchAppId) => void;
  onTogglePin: (id: WorkbenchAppId) => void; focusGroup: string | null;
}) {
  const [raw, setRaw] = useState("");
  const [decoded, setDecoded] = useState<DecodedPacket | null>(null);
  const [station, setStation] = useState<StationDetail | null>(null);
  const [ports, setPorts] = useState<PortStat[]>([]);
  const [peers, setPeers] = useState<FedPeer[]>([]);
  const fmt = useFmt();
  const toast = useToast();
  const messages = usePaged((cursor) => getMessages(false, cursor).then((r) => ({ items: r.messages, nextCursor: r.nextCursor, hasMore: r.hasMore })), []);

  useEffect(() => {
    getPorts().then((r) => setPorts(r.ports)).catch(console.error);
    listFederationPeers().then((r) => setPeers(r.peers)).catch(console.error);
  }, []);

  const feedUrl = (() => {
    const b = props.map?.getBounds();
    return b ? cotUrl([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]) : "";
  })();

  useEffect(() => {
    if (!props.picked) { setStation(null); return; }
    let live = true;
    getStation(props.picked).then((r) => { if (live) setStation(r.station); }).catch(console.error);
    return () => { live = false; };
  }, [props.picked]);

  async function decode() {
    try { setDecoded(await decodePacket(raw.trim())); }
    catch (e) { setDecoded({ ok: false, error: (e as Error).message }); }
  }

  const SAMPLE = "OE8APR-9>APRS,WIDE1-1,qAR,OE8XXX:!4704.41N/01526.27E>088/036/A=001234Mobile";

  return (
    <Panel title="📡 Workbench" onClose={props.onClose}>
      <p className="muted">Launch a workbench app, or pin it (📌) to the left rail for one-click access.</p>

      {/* app launcher — the workbench functions available as launchable, pinnable apps */}
      <div className="wb-apps" role="list">
        {props.apps.map((app) => {
          const pinned = props.pinned.includes(app.id);
          return (
            <div key={app.id} className="wb-app" role="listitem">
              <button className="wb-app-launch" onClick={() => props.onLaunchApp(app.id)}>
                <Icon name={app.icon} size={22} />
                <span className="wb-app-t"><span className="wb-app-label">{app.label}</span>
                  <span className="wb-app-blurb muted">{app.blurb}</span></span>
              </button>
              <button className={`icon wb-pin${pinned ? " on" : ""}`} aria-pressed={pinned}
                title={pinned ? `Unpin ${app.label} from the rail` : `Pin ${app.label} to the rail`}
                onClick={() => props.onTogglePin(app.id)}>
                <Icon name={pinned ? "pin-off" : "pin"} size={16} />
              </button>
            </div>
          );
        })}
      </div>

      <h3 className="wb-config-h">Configuration</h3>

      <Group title="Live stations" status={props.stationsOn ? `${props.stationCount} on map` : "off"}
             master={{ on: props.stationsOn, set: props.setStationsOn }}
             reason="Switch on to plot live APRS stations on the map.">
        {station ? (
          <div className="logform">
            <div className="row between">
              <h3 className="mono m-0">{station.callsign}</h3>
              <button className="link" onClick={() => props.onPick(null)}>clear</button>
            </div>
            <div className="muted">{station.symbol ?? "—"} · last heard {fmt.ago(station.lastSeen)}</div>
            {station.roles?.length ? <div className="badges mt-1">{station.roles.map((r) => <Badge key={r}>{ROLE_META[r as StationRole]?.label ?? r}</Badge>)}</div> : null}
            {station.comment && <div className="comment">{station.comment}</div>}
            <div className="muted mt-1">
              {station.speedKn != null && station.speedKn > 0 ? `${fmt.speed(station.speedKn)} @ ${station.course ?? 0}° · ` : ""}
              {station.altitudeM != null ? `${fmt.altitude(station.altitudeM)} · ` : ""}
              {station.packets} pkts · {station.track.length} track pts
            </div>
            {station.wx && (
              <div className="wx">
                {station.wx.tempC != null && <>🌡 {fmt.temp(station.wx.tempC)} · </>}
                💧 {station.wx.humidity ?? "—"}% ·{" "}
                {station.wx.windKn != null && <>🌬 {fmt.speed(station.wx.windKn)} · </>}
                {station.wx.pressureHpa ?? "—"} hPa</div>
            )}
            <div className="row between mt-3">
              {props.callsign.length >= 3
                ? <button onClick={async () => {
                    try { await createStation({ callsign: station.callsign }); toast(`${station.callsign} added to your stations`); }
                    catch (e) { toast((e as Error).message); }
                  }}>+ add to my stations</button>
                : <span />}
              <button onClick={() => props.onFly(station.lat, station.lon)}>fly to</button>
            </div>
            <TrackReplay map={props.map} callsign={station.callsign} />
            <StationGraphs callsign={station.callsign} />
            <StationPackets callsign={station.callsign} />
          </div>
        ) : <p className="muted">Tap a station pin on the map to inspect it.</p>}
      </Group>

      <Group title="Transports" status={`${ports.length} port${ports.length === 1 ? "" : "s"} · 24h RX`} defaultOpen={false}>
        {ports.length === 0 ? <EmptyState>No traffic yet.</EmptyState> : ports.map((p) => (
          <Row key={p.port} label={<span className="mono">{p.port}</span>}><span className="muted">{fmt.num(p.rx, 0)} rx</span></Row>
        ))}
      </Group>

      <Group title="Packet decoder" defaultOpen={props.focusGroup === "Packet decoder"}>
        <textarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={3} placeholder="paste a raw TNC2 / APRS-IS line…" />
        <div className="row between mt-2">
          <button className="link" onClick={() => setRaw(SAMPLE)}>use a sample</button>
          <button className="primary" onClick={decode} disabled={!raw.trim()}>Decode</button>
        </div>
        {decoded && !decoded.ok && <p className="error">{decoded.error}</p>}
        {decoded?.ok && decoded.frame && (
          <div className="decoded">
            <div className="row between">
              <strong className="mono">{decoded.frame.src}</strong>
              <Badge kind={decoded.frame.heardVia === "rf" ? "tierA" : undefined}>{decoded.frame.heardVia}</Badge>
            </div>
            <div className="muted">→ {decoded.frame.dst} · {decoded.frame.path.join(" · ") || "(no path)"}</div>
            <div className="kind">{String(decoded.data?.kind)}</div>
            <dl className="fields">
              {decoded.data && Object.entries(flatten(decoded.data)).map(([k, v]) => (<div key={k}><dt>{k}</dt><dd>{v}</dd></div>))}
            </dl>
          </div>
        )}
      </Group>

      <Group title="TAK / CoT feed" defaultOpen={false}>
        <p className="muted">Add this as a data feed in ATAK/WinTAK to see APRS stations as CoT:</p>
        <div className="row">
          <input className="mono" readOnly value={feedUrl} onFocus={(e) => e.currentTarget.select()} />
          <button onClick={() => { navigator.clipboard?.writeText(feedUrl); toast("Feed URL copied"); }}>copy</button>
        </div>
      </Group>

      <Group title="Messages" status={messages.items.length ? `${messages.items.length}${messages.hasMore ? "+" : ""} recent` : "none"} defaultOpen={false}>
        {messages.items.length === 0 ? <EmptyState>No inbound messages.</EmptyState> : (
          <ul className="logs">
            {messages.items.map((mm) => (
              <li key={mm.id}>
                <Badge><span className="mono">{mm.fromCall}</span></Badge>→ <span className="mono">{mm.toCall}</span> <span className="muted">· {fmt.ago(mm.ts)}</span>
                <div className="comment">{mm.body}</div>
              </li>
            ))}
          </ul>
        )}
        <LoadMore hasMore={messages.hasMore} loading={messages.loading} onClick={messages.loadMore} />
      </Group>

      <Group title="Federation" status={peers.length ? `${peers.length} peer${peers.length === 1 ? "" : "s"}` : "none"} defaultOpen={false}>
        {peers.length === 0 ? <EmptyState>No federation peers configured.</EmptyState> : (
          <ul className="logs">
            {peers.map((p) => (
              <li key={p.url}>
                <Badge kind={p.health === "ok" ? "found" : p.health === "error" ? "dnf" : "warn"} title={`trust: ${p.trust}`}>{p.health}</Badge>
                <span className="mono">{p.instance ?? p.url}</span>
                <span className="muted"> · {p.trust}{p.signed ? " · signed" : ""}</span>
                <div className="comment">
                  {p.last_ok ? `synced ${fmt.ago(p.last_ok)}` : "never synced"} · {p.mirrored_total} mirrored
                  {p.rep_confirmed > 0 && ` · ${p.rep_confirmed} corroborations`}
                  {p.sync_err > 0 && ` · ${Math.round(p.errorRate * 100)}% errors`}
                </div>
                {p.health === "error" && p.last_error && <div className="comment error">{p.last_error}</div>}
              </li>
            ))}
          </ul>
        )}
      </Group>

      <Group title="Watchlist" defaultOpen={false}>
        <Watchlist callsign={props.callsign} onFly={props.onFly} />
      </Group>

      <Group title="RF (browser)" status="Web Serial · BLE" defaultOpen={false}>
        <RfBrowser callsign={props.callsign} verified={props.verified} />
      </Group>

      <Group title="NET/ROM node" status="node · digipeater · sysop" defaultOpen={false}>
        <p className="muted">Run a NET/ROM node + connected-mode digipeater with the classic sysop command set. The packet terminal (above) connects to it.</p>
        <NodePanel />
      </Group>

      <Group title="Tools (plugins)" status="sandboxed · off by default" defaultOpen={props.focusGroup === "Tools (plugins)"}>
        <ToolsPanel callsign={props.callsign} verified={props.verified} />
      </Group>

      <Group title="Rig control (CAT)" status="one-click tune" defaultOpen={props.focusGroup === "Rig control (CAT)"}>
        <p className="muted">Tune your transceiver over Web Serial — the APRS frequency, a manual MHz, or a live spot's freq. Tuning only (no transmit).</p>
        <RigControl />
      </Group>

      <Group title="Remote control — your box" status={props.verified ? "TX ready" : "RX only"} defaultOpen={props.focusGroup === "Remote control — your box"}>
        <RemoteControl callsign={props.callsign} verified={props.verified} map={props.map} />
      </Group>
    </Panel>
  );
}

function flatten(data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === "kind") continue;
    if (v == null) continue;
    if (typeof v === "object") {
      if (k === "symbol" && (v as any).label) { out.symbol = `${(v as any).label} (${(v as any).table}${(v as any).code})`; continue; }
      out[k] = JSON.stringify(v);
    } else out[k] = String(v);
  }
  return out;
}
