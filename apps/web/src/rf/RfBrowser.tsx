// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useReducer, useRef, useState } from "react";
import {
  WebSerialKiss, WebBluetoothKiss, webSerialSupported, webBluetoothSupported, type RfFrame, type RfLink,
} from "./kiss.js";
import { WebAudioAfsk, WebSerialMeshtastic, webAudioSupported } from "./extralinks.js";
import { encodeAprsPosition, encodeAprsMessage, ackReply, syncBackBatch, type LocalMessage } from "@aprsweb/aprs";
import { fieldStation } from "./fieldStation.js";
import { ingestPackets, ingestSigned, registerKey } from "../api.js";
import { devicePublicKey } from "../crypto.js";
import { useFmt } from "../format.js";
import { Row, Switch, EmptyState, Advanced, useToast, Ico } from "../ui/index.js";

const FWD_KEY = "acs.rf.forward"; // { url, secret } for the self-host (ingest-secret) path
type LinkKind = "serial" | "ble" | "audio" | "mesh";
const LINK_LABEL: Record<LinkKind, string> = { serial: "USB radio", ble: "Bluetooth radio", audio: "Soundcard (AFSK)", mesh: "Meshtastic node" };

/**
 * Workbench → RF (browser): connect a KISS TNC over Web Serial (USB) or Web Bluetooth (BLE) and
 * decode live RF here, no server (docs/design/16 H1 + H2). Optionally forward to a gateway — signed with
 * your device key for a public gateway (H1.5), or with an ingest secret for self-host. Chromium-only.
 */
export function RfBrowser(props: { callsign: string; verified: boolean }) {
  const fmt = useFmt();
  const toast = useToast();
  const serialOk = webSerialSupported();
  const bleOk = webBluetoothSupported();
  const audioOk = webAudioSupported();
  const signedIn = props.callsign.length >= 3;
  const base = props.callsign.toUpperCase().split("-")[0] ?? "";

  // H5 gated TX — OFF by default; only available on a control-verified callsign + explicit opt-in.
  const [txOn, setTxOn] = useState(false);
  const [ssid, setSsid] = useState("7");
  const [bcn, setBcn] = useState({ lat: "", lon: "", symbol: "/>", comment: "" });
  const [msg, setMsg] = useState({ to: "", text: "" });
  const [txBusy, setTxBusy] = useState(false);
  const txCall = ssid && ssid !== "0" ? `${base}-${ssid}` : base;

  const [link, setLink] = useState<LinkKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [frames, setFrames] = useState<RfFrame[]>([]);
  const [count, setCount] = useState(0);
  const [fwdOn, setFwdOn] = useState(false);
  const [mode, setMode] = useState<"signed" | "secret">(signedIn ? "signed" : "secret");
  const [secretCfg, setSecretCfg] = useState<{ url: string; secret: string }>(() => {
    try { return JSON.parse(localStorage.getItem(FWD_KEY) || "null") ?? { url: "", secret: "" }; } catch { return { url: "", secret: "" }; }
  });

  const linkRef = useRef<RfLink | null>(null);
  const fwd = useRef({ on: false, mode, secretCfg, callsign: props.callsign });
  fwd.current = { on: fwdOn, mode, secretCfg, callsign: props.callsign };
  const fwdErr = useRef(false); // throttle: surface a forward error only once per session

  useEffect(() => () => { void linkRef.current?.disconnect(); }, []);

  // Field station (docs/design/16 A/D): re-render when the local sink updates (live stations + inbox).
  const [, forceField] = useReducer((n: number) => n + 1, 0);
  useEffect(() => fieldStation.subscribe(() => forceField()), []);

  /** (B) ACK a message heard for us over the radio — H5-gated, reuses the KISS TX path. */
  async function ackMessage(mm: LocalMessage) {
    const info = ackReply(mm, props.callsign);
    if (!info || !linkRef.current || !txOn) return;
    setTxBusy(true);
    try { await linkRef.current.send({ src: `${base}-${ssid}`, dst: "APZACG", path: ["WIDE1-1"], payload: info }); toast(`ACK ${mm.msgNo} → ${mm.from}`); }
    catch (e) { toast(`TX failed: ${(e as Error).message}`); }
    finally { setTxBusy(false); }
  }

  /** (D) Sync-back: replay locally-heard receptions to a gateway once online (via the forward path). */
  async function syncBack() {
    const heard = fieldStation.heardForSync();
    const keep = new Set(syncBackBatch(heard.map((h) => ({ raw: h.raw, at: h.at })), props.callsign).map((h) => h.raw));
    const packets = heard.filter((h) => keep.has(h.raw)).map((h) => h.packet);
    if (!packets.length) { toast("Nothing new to sync."); return; }
    const c = fwd.current;
    const send = c.mode === "signed" && c.callsign.length >= 3 ? ingestSigned(packets, c.callsign)
      : c.secretCfg.secret ? ingestPackets(packets, c.secretCfg.secret, c.secretCfg.url || undefined) : null;
    if (!send) { toast("Configure gateway forwarding first (below)."); return; }
    try { await send; fieldStation.clearHeard(); toast(`Synced ${packets.length} heard frame(s).`); }
    catch (e) { toast(`Sync failed: ${(e as Error).message}`); }
  }

  function onFrame(f: RfFrame) {
    setFrames((prev) => [f, ...prev].slice(0, 100));
    setCount((n) => n + 1);
    fieldStation.feed(f);        // off-grid sink (docs/design/16 A): live stations + local inbox, gateway-independent
    const c = fwd.current;
    if (!c.on) return;
    const p = [f.packet];
    const send = c.mode === "signed" && c.callsign.length >= 3
      ? ingestSigned(p, c.callsign)
      : c.secretCfg.secret ? ingestPackets(p, c.secretCfg.secret, c.secretCfg.url || undefined) : null;
    if (send) send.catch((e) => { if (!fwdErr.current) { fwdErr.current = true; toast(`Forwarding failed: ${(e as Error).message}`); } });
  }

  async function connect(kind: LinkKind) {
    setBusy(true);
    try {
      const onClose = (err?: Error) => { setLink(null); linkRef.current = null; if (err) toast(`Radio disconnected: ${err.message}`); };
      const l: RfLink & { connect(): Promise<void> } =
        kind === "serial" ? new WebSerialKiss(onFrame, onClose)
        : kind === "ble" ? new WebBluetoothKiss(onFrame, onClose)
        : kind === "audio" ? new WebAudioAfsk(onFrame, onClose)
        : new WebSerialMeshtastic(onFrame, onClose);
      await l.connect();
      linkRef.current = l; setLink(kind); fwdErr.current = false;
      toast(LINK_LABEL[kind] + " connected");
    } catch (e) {
      const m = (e as Error).message || "";
      if (!/No port selected|chooser|cancel|User cancelled|Permission denied|NotAllowed/i.test(m)) toast(`Could not connect: ${m}`);
    } finally { setBusy(false); }
  }
  async function disconnect() { await linkRef.current?.disconnect(); linkRef.current = null; setLink(null); }

  async function enableForward(on: boolean) {
    if (on && mode === "signed" && signedIn) {
      const key = await devicePublicKey();
      if (!key) { toast("This browser can't sign (needs Ed25519). Use the self-host secret instead."); return; }
      await registerKey({ callsign: props.callsign, publicKey: key, label: "browser RF" }).catch(() => {}); // ensure the key is registered
    }
    fwdErr.current = false; setFwdOn(on);
  }
  function saveSecret(url: string, secret: string) {
    const v = { url: url.trim(), secret: secret.trim() }; setSecretCfg(v);
    try { localStorage.setItem(FWD_KEY, JSON.stringify(v)); } catch { /* ignore */ }
  }

  // H5 transmit — gated on a verified callsign + opt-in; every send is a deliberate, confirmed action.
  async function tx(payload: string, what: string) {
    const l = linkRef.current;
    if (!l || !props.verified || !txOn) return;
    setTxBusy(true);
    try { await l.send({ src: txCall, dst: "APRS", path: ["WIDE1-1"], payload }); toast(`Transmitted: ${what}`); }
    catch (e) { toast(`TX failed: ${(e as Error).message}`); }
    finally { setTxBusy(false); }
  }
  async function beacon() {
    const lat = Number(bcn.lat), lon = Number(bcn.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { toast("Enter a valid latitude and longitude"); return; }
    if (!confirm(`Transmit a position beacon as ${txCall}?`)) return;
    await tx(encodeAprsPosition(lat, lon, bcn.symbol || "/>", bcn.comment), "position");
  }
  async function sendMsg() {
    if (!msg.to.trim() || !msg.text.trim()) { toast("Enter a recipient and a message"); return; }
    if (!confirm(`Transmit a message to ${msg.to.toUpperCase()} as ${txCall}?`)) return;
    await tx(encodeAprsMessage(msg.to, msg.text), `message to ${msg.to.toUpperCase()}`);
  }
  function useMyLocation() {
    navigator.geolocation?.getCurrentPosition(
      (p) => setBcn((b) => ({ ...b, lat: p.coords.latitude.toFixed(5), lon: p.coords.longitude.toFixed(5) })),
      () => toast("Couldn't get your location"));
  }

  if (!serialOk && !bleOk && !audioOk) return (
    <p className="muted">Browser-direct RF needs <strong>Web Serial</strong>, <strong>Web Bluetooth</strong> or
      <strong> Web Audio</strong> — Chromium-based desktop/Android browsers over HTTPS. On other browsers, run the
      operator-local <span className="mono"> apps/ingest</span> instead. RX never implies trust — finds are still
      gated by the verification engine.</p>
  );

  return (
    <>
      <p className="muted">Decode RF here with no server — a KISS TNC (USB/BLE), a radio's audio through the
        soundcard (no TNC), or a Meshtastic/LoRa node. Frames heard on your own radio are Tier C (no independent
        IGate); verification is unchanged.</p>

      <div className="row gap-2">
        {link
          ? <button className="danger" onClick={disconnect}>Disconnect</button>
          : <>
              {serialOk && <button className="primary" onClick={() => connect("serial")} disabled={busy}>{busy ? "…" : "Connect USB radio"}</button>}
              {bleOk && <button onClick={() => connect("ble")} disabled={busy}>{busy ? "…" : "Connect Bluetooth"}</button>}
              {audioOk && <button onClick={() => connect("audio")} disabled={busy} title="Decode APRS audio from a radio via the soundcard — no TNC (H4)">{busy ? "…" : "Soundcard AFSK"}</button>}
              {serialOk && <button onClick={() => connect("mesh")} disabled={busy} title="Read a Meshtastic/LoRa node's positions over USB (H3)">{busy ? "…" : "Meshtastic node"}</button>}
            </>}
        <span className="muted">{link ? `● live (${LINK_LABEL[link]}) · ${count} frame${count === 1 ? "" : "s"}` : "not connected"}</span>
      </div>

      <Row label="Forward to a gateway" help={mode === "signed" ? "Signed with your device key (public gateway, no secret)" : "With an ingest secret (self-host)"}>
        <Switch label="Forward to a gateway" checked={fwdOn} disabled={mode === "secret" && !secretCfg.secret}
                onChange={(v) => { void enableForward(v); }} />
      </Row>
      <Row label="Auth">
        <div className="seg">
          <button className={mode === "signed" ? "on" : ""} disabled={!signedIn} onClick={() => setMode("signed")}>signed ({props.callsign || "sign in"})</button>
          <button className={mode === "secret" ? "on" : ""} onClick={() => setMode("secret")}>secret (self-host)</button>
        </div>
      </Row>
      {mode === "secret" && (
        <Advanced label="Self-host gateway">
          <label>Gateway base URL <input className="mono" defaultValue={secretCfg.url} placeholder="https://your-gateway"
            onBlur={(e) => saveSecret(e.target.value, secretCfg.secret)} /></label>
          <label>Ingest secret <input className="mono" type="password" defaultValue={secretCfg.secret} placeholder="INGEST_SECRET"
            onBlur={(e) => saveSecret(secretCfg.url, e.target.value)} /></label>
          <p className="muted fine">Stored only in this browser.</p>
        </Advanced>
      )}

      {link && (
        <div className="tx-block">
          <h4>Transmit (H5)</h4>
          {!props.verified
            ? <p className="muted">Transmit is for <strong>licensed, control-verified</strong> operators only — verify
                your callsign in Settings → Account to enable it. (RX is always available; trust is unaffected.)</p>
            : <>
                <Row label="Enable transmit" help="You are a licensed operator and are responsible for what you send">
                  <Switch label="Enable transmit" checked={txOn} onChange={setTxOn} />
                </Row>
                {txOn && <>
                  <Row label="TX callsign">
                    <span className="mono">{base}-</span>
                    <input className="field-sm mono" value={ssid} inputMode="numeric" maxLength={2}
                           onChange={(e) => setSsid(e.target.value.replace(/[^0-9]/g, ""))} aria-label="SSID" />
                    <span className="muted"> → {txCall}</span>
                  </Row>
                  <h5>Beacon position</h5>
                  <div className="row gap-2">
                    <input className="mono field-sm" placeholder="lat" aria-label="Latitude" value={bcn.lat} onChange={(e) => setBcn((b) => ({ ...b, lat: e.target.value }))} />
                    <input className="mono field-sm" placeholder="lon" aria-label="Longitude" value={bcn.lon} onChange={(e) => setBcn((b) => ({ ...b, lon: e.target.value }))} />
                    <button onClick={useMyLocation} title="Use my location" aria-label="Use my location"><Ico e="📍" c="@" /></button>
                  </div>
                  <input placeholder="comment (optional)" aria-label="Beacon comment" maxLength={43} value={bcn.comment} onChange={(e) => setBcn((b) => ({ ...b, comment: e.target.value }))} />
                  <div className="row end"><button className="primary" onClick={beacon} disabled={txBusy}>Beacon</button></div>
                  <h5>Message</h5>
                  <div className="row gap-2">
                    <input className="mono field-sm" placeholder="to" aria-label="Message recipient" maxLength={9} value={msg.to} onChange={(e) => setMsg((m) => ({ ...m, to: e.target.value }))} />
                    <input placeholder="message" aria-label="Message text" maxLength={67} value={msg.text} onChange={(e) => setMsg((m) => ({ ...m, text: e.target.value }))} />
                  </div>
                  <div className="row end"><button className="primary" onClick={sendMsg} disabled={txBusy}>Send</button></div>
                  <p className="muted fine">Each transmit is deliberate. Do not transmit without a valid licence for <span className="mono">{base}</span>.</p>
                </>}
              </>}
        </div>
      )}

      {/* Field station (docs/design/16 A/B/D): local RF -> live stations + inbox, no gateway needed. */}
      {(() => { const stations = fieldStation.liveStations(); const inbox = fieldStation.inbox(); const heardN = fieldStation.heardForSync().length;
        return (stations.length > 0 || inbox.length > 0) ? (
        <div className="field-station">
          <div className="row between">
            <h4>Field station <span className="muted fine">off-grid · no gateway</span></h4>
            <button onClick={syncBack} disabled={heardN === 0} title="Replay locally-heard frames to a gateway when back online">
              Sync {heardN} heard
            </button>
          </div>
          <div className="fs-cols">
            <div>
              <div className="ulabel">Stations heard <span className="muted fine">({stations.length})</span></div>
              {stations.length === 0 ? <EmptyState>None yet.</EmptyState> : (
                <ul className="logs">{stations.slice(0, 30).map((s) => (
                  <li key={s.callsign}>
                    <span className="mono"><strong>{s.callsign}</strong></span>
                    <span className="muted"> · {s.lat.toFixed(3)},{s.lon.toFixed(3)}</span>
                    {s.kind !== "station" && <span className="muted"> · {s.kind}</span>}
                    <span className="muted"> · {fmt.ago(s.heardAt / 1000)}</span>
                    {s.comment && <div className="comment mono">{s.comment.slice(0, 60)}</div>}
                  </li>
                ))}</ul>
              )}
            </div>
            <div>
              <div className="ulabel">Local inbox <span className="muted fine">({inbox.length})</span></div>
              {inbox.length === 0 ? <EmptyState>No messages.</EmptyState> : (
                <ul className="logs">{inbox.slice(0, 30).map((mm: LocalMessage, i) => (
                  <li key={`${mm.at}-${i}`}>
                    <span className="mono"><strong>{mm.from}</strong>{mm.ack ? " (ack)" : ""} &rarr; {mm.to}</span>
                    <span className="muted"> · {fmt.ago(mm.at / 1000)}</span>
                    <div className="comment mono">{mm.text.slice(0, 80)}</div>
                    {txOn && link && ackReply(mm, props.callsign) &&
                      <button className="fine" onClick={() => ackMessage(mm)} disabled={txBusy}>ACK {mm.msgNo}</button>}
                  </li>
                ))}</ul>
              )}
            </div>
          </div>
        </div>
      ) : null; })()}

      <h4>Live RX</h4>
      {frames.length === 0
        ? <EmptyState>{link ? "Listening… frames appear as your radio hears them." : "Connect a radio to see live packets."}</EmptyState>
        : <ul className="logs rf-rx">{frames.map((f, i) => (
            <li key={`${f.at}-${i}`}>
              <span className="mono"><strong>{f.frame.src}</strong>{f.frame.dst ? `>${f.frame.dst}` : ""}</span>
              <span className="muted"> {f.data.kind}</span>
              {"lat" in f.data && typeof (f.data as { lat?: number }).lat === "number" &&
                <span className="muted"> · {(f.data as { lat: number }).lat.toFixed(3)},{(f.data as { lon: number }).lon.toFixed(3)}</span>}
              <span className="muted"> · {fmt.ago(f.at / 1000)}</span>
              <div className="comment mono">{f.frame.payload.slice(0, 80)}</div>
            </li>
          ))}</ul>}
    </>
  );
}
