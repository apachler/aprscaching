import { useEffect, useState } from "react";
import type maplibregl from "maplibre-gl";
import { getPorts, cotUrl, type PortStat } from "../api.js";
import { useFmt } from "../format.js";
import { Row, EmptyState, useToast } from "../ui/index.js";
import { RfBrowser } from "../rf/RfBrowser.js";

/**
 * ConnectionsSettings — the APRS data-plane sources that feed the platform: the ingest transports
 * (APRS-IS / KISS / Meshtastic), the browser-direct RF bridge (Web Serial / BLE, a first-class
 * operator-local ingest), and the TAK/CoT output feed. Lives in Settings → "Connections & sources"
 * (moved out of the workbench, which is now a pure app launcher).
 */
export function ConnectionsSettings(props: { callsign: string; verified: boolean; map: maplibregl.Map | null }) {
  const fmt = useFmt();
  const toast = useToast();
  const [ports, setPorts] = useState<PortStat[]>([]);
  useEffect(() => { getPorts().then((r) => setPorts(r.ports)).catch(console.error); }, []);
  const feedUrl = (() => {
    const b = props.map?.getBounds();
    return b ? cotUrl([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]) : "";
  })();

  return (
    <>
      <h4 className="set-subh">Transports <span className="muted">· {ports.length} port{ports.length === 1 ? "" : "s"} · 24h RX</span></h4>
      {ports.length === 0 ? <EmptyState>No traffic yet.</EmptyState> : ports.map((p) => (
        <Row key={p.port} label={<span className="mono">{p.port}</span>}><span className="muted">{fmt.num(p.rx, 0)} rx</span></Row>
      ))}

      <h4 className="set-subh">RF (browser) <span className="muted">· Web Serial · BLE</span></h4>
      <RfBrowser callsign={props.callsign} verified={props.verified} />

      <h4 className="set-subh">TAK / CoT feed</h4>
      <p className="muted">Add this as a data feed in ATAK/WinTAK to see APRS stations as CoT:</p>
      <div className="row">
        <input className="mono" readOnly value={feedUrl} onFocus={(e) => e.currentTarget.select()} />
        <button onClick={() => { navigator.clipboard?.writeText(feedUrl); toast("Feed URL copied"); }}>copy</button>
      </div>
    </>
  );
}
