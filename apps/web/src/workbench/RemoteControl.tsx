// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useState } from "react";
import maplibregl from "maplibre-gl";
import { enqueueBoxCommand, getBoxLog, type BoxCommand } from "../api.js";
import { useFmt } from "../format.js";
import { Row, Badge, EmptyState, useToast, Ico } from "../ui/index.js";

/**
 * Remote control of your own ingest box (docs/design/20 R2). The web app enqueues commands; the box pulls
 * them over its existing outbound connection. TX is gated on callsign control-verification (H5):
 * unverified operators get RX/status only, with the transmit controls disabled + a reason.
 */
export function RemoteControl(props: { callsign: string; verified: boolean; map: maplibregl.Map | null }) {
  const fmt = useFmt();
  const toast = useToast();
  const [boxId, setBoxId] = useState(() => { try { return localStorage.getItem("acs.boxId") ?? ""; } catch { return ""; } });
  const [to, setTo] = useState("");
  const [text, setText] = useState("");
  const [comment, setComment] = useState("");
  const [log, setLog] = useState<BoxCommand[]>([]);
  const signedIn = props.callsign.length >= 3;
  const canTx = signedIn && props.verified;

  useEffect(() => { try { localStorage.setItem("acs.boxId", boxId); } catch { /* ignore */ } }, [boxId]);
  const refresh = useCallback(() => { if (boxId) getBoxLog(boxId).then((r) => setLog(r.commands)).catch(() => {}); }, [boxId]);
  useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t); }, [refresh]);

  async function send(kind: string, payload?: unknown) {
    if (!boxId) { toast("Set your box ID first"); return; }
    try { await enqueueBoxCommand(boxId, { kind, payload, callsign: props.callsign }); toast(`${kind} queued`); refresh(); }
    catch (e) { toast((e as Error).message); }
  }
  function beacon() { const c = props.map?.getCenter(); send("beacon", { lat: c?.lat, lon: c?.lng, comment: comment || undefined }); }
  function sendMessage() { send("message", { to: to.trim().toUpperCase(), text: text.trim() }); setText(""); }

  const stColor: Record<string, "tierA" | "tierB" | "tierC"> = { done: "tierA", sent: "tierB", queued: "tierC", failed: "tierC" };

  return (
    <>
      <p className="muted">Operate your own ingest box — no port-forward. Commands queue here and your box pulls them.</p>
      <Row label="Box ID" help="The id your ingest box polls with (set it on the box too)">
        <input value={boxId} onChange={(e) => setBoxId(e.target.value)} placeholder="pi-home" aria-label="Box ID" />
      </Row>
      {!signedIn
        ? <p className="muted">Sign in to control a box.</p>
        : !props.verified && <p className="muted">Verify your callsign to transmit — RX &amp; status only until then (H5).</p>}

      <div className="row wrap gap-2">
        <button onClick={() => send("status")} disabled={!signedIn || !boxId}>↻ Status</button>
        <button onClick={beacon} disabled={!canTx || !boxId} title={canTx ? "Beacon the map centre" : "verify callsign to transmit"}><Ico e="📍 " />Beacon here</button>
        <button onClick={() => send("igate", { on: true })} disabled={!canTx || !boxId}>IGate on</button>
        <button onClick={() => send("igate", { on: false })} disabled={!canTx || !boxId}>IGate off</button>
        <button onClick={() => send("digi", { on: true })} disabled={!canTx || !boxId}>Digi on</button>
        <button onClick={() => send("tx", { on: false })} disabled={!canTx || !boxId}>TX off</button>
      </div>

      <label>Beacon comment
        <input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={43} placeholder="optional status text" />
      </label>
      <Row label="Message">
        <div className="row gap-2">
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="OE3ABC" aria-label="To callsign" className="mono field-sm" />
          <input value={text} onChange={(e) => setText(e.target.value)} maxLength={67} placeholder="message…" aria-label="Message text" />
          <button className="primary" disabled={!canTx || !boxId || !to.trim() || !text.trim()} onClick={sendMessage}>Send</button>
        </div>
      </Row>

      <h4>Command log</h4>
      {log.length === 0
        ? <EmptyState>No commands yet.</EmptyState>
        : <ul className="logs">{log.map((c) => (
            <li key={c.id}>
              <Badge>{c.kind}</Badge> <Badge kind={stColor[c.status] ?? "tierC"}>{c.status}</Badge>
              <span className="muted"> · {fmt.ago(c.createdAt)}</span>
              {c.result && <span className="muted"> · {c.result}</span>}
            </li>
          ))}</ul>}
    </>
  );
}
