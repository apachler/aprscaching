import { useEffect, useState } from "react";
import maplibregl from "maplibre-gl";
import {
  getPorts, cotUrl, getStation, listFederationPeers, createStation,
  type StationDetail, type PortStat, type FedPeer,
} from "../api.js";
import { ROLE_META } from "../stationRoles.js";
import type { StationRole } from "@aprsweb/shared";
import { useFmt } from "../format.js";
import { Panel, Group, Row, Badge, EmptyState, useToast, Icon } from "../ui/index.js";
import type { WorkbenchApp, WorkbenchAppId } from "./apps.js";
import { Watchlist } from "./Watchlist.js";
import { RfBrowser } from "../rf/RfBrowser.js";
import { TrackReplay } from "./TrackReplay.js";
import { StationGraphs } from "./StationGraphs.js";
import { StationPackets } from "./StationPackets.js";

/**
 * Workbench — the app launcher + the operator toolset config that hasn't yet moved to its proper
 * home. Every workbench APP (terminal, BBS, decoder, node, tools, rig, remote) launches into its own
 * surface (WorkbenchAppSurface); this panel is the launcher plus the remaining platform-config groups.
 */
export function WorkbenchPanel(props: {
  onClose: () => void; map: maplibregl.Map | null; callsign: string; verified: boolean;
  stationsOn: boolean; setStationsOn: (v: boolean) => void; stationCount: number;
  picked: string | null; onPick: (cs: string | null) => void; onFly: (lat: number, lon: number) => void;
  apps: WorkbenchApp[]; pinned: WorkbenchAppId[]; onLaunchApp: (id: WorkbenchAppId) => void;
  onTogglePin: (id: WorkbenchAppId) => void;
}) {
  const [station, setStation] = useState<StationDetail | null>(null);
  const [ports, setPorts] = useState<PortStat[]>([]);
  const [peers, setPeers] = useState<FedPeer[]>([]);
  const fmt = useFmt();
  const toast = useToast();

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

      <Group title="TAK / CoT feed" defaultOpen={false}>
        <p className="muted">Add this as a data feed in ATAK/WinTAK to see APRS stations as CoT:</p>
        <div className="row">
          <input className="mono" readOnly value={feedUrl} onFocus={(e) => e.currentTarget.select()} />
          <button onClick={() => { navigator.clipboard?.writeText(feedUrl); toast("Feed URL copied"); }}>copy</button>
        </div>
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
    </Panel>
  );
}
