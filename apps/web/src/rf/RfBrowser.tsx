import { useEffect, useRef, useState } from "react";
import {
  WebSerialKiss, WebBluetoothKiss, webSerialSupported, webBluetoothSupported, type RfFrame, type RfLink,
} from "./kiss.js";
import { encodeAprsPosition, encodeAprsMessage } from "@aprsweb/aprs";
import { ingestPackets, ingestSigned, registerKey } from "../api.js";
import { devicePublicKey } from "../crypto.js";
import { useFmt } from "../format.js";
import { Row, Switch, EmptyState, Advanced, useToast } from "../ui/index.js";

const FWD_KEY = "acs.rf.forward"; // { url, secret } for the self-host (ingest-secret) path

/**
 * Workbench → RF (browser): connect a KISS TNC over Web Serial (USB) or Web Bluetooth (BLE) and
 * decode live RF here, no server (docs/16 H1 + H2). Optionally forward to a gateway — signed with
 * your device key for a public gateway (H1.5), or with an ingest secret for self-host. Chromium-only.
 */
export function RfBrowser(props: { callsign: string; verified: boolean }) {
  const fmt = useFmt();
  const toast = useToast();
  const serialOk = webSerialSupported();
  const bleOk = webBluetoothSupported();
  const signedIn = props.callsign.length >= 3;
  const base = props.callsign.toUpperCase().split("-")[0] ?? "";

  // H5 gated TX — OFF by default; only available on a control-verified callsign + explicit opt-in.
  const [txOn, setTxOn] = useState(false);
  const [ssid, setSsid] = useState("7");
  const [bcn, setBcn] = useState({ lat: "", lon: "", symbol: "/>", comment: "" });
  const [msg, setMsg] = useState({ to: "", text: "" });
  const [txBusy, setTxBusy] = useState(false);
  const txCall = ssid && ssid !== "0" ? `${base}-${ssid}` : base;

  const [link, setLink] = useState<"serial" | "ble" | null>(null);
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

  function onFrame(f: RfFrame) {
    setFrames((prev) => [f, ...prev].slice(0, 100));
    setCount((n) => n + 1);
    const c = fwd.current;
    if (!c.on) return;
    const p = [f.packet];
    const send = c.mode === "signed" && c.callsign.length >= 3
      ? ingestSigned(p, c.callsign)
      : c.secretCfg.secret ? ingestPackets(p, c.secretCfg.secret, c.secretCfg.url || undefined) : null;
    if (send) send.catch((e) => { if (!fwdErr.current) { fwdErr.current = true; toast(`Forwarding failed: ${(e as Error).message}`); } });
  }

  async function connect(kind: "serial" | "ble") {
    setBusy(true);
    try {
      const onClose = (err?: Error) => { setLink(null); linkRef.current = null; if (err) toast(`Radio disconnected: ${err.message}`); };
      const l = kind === "serial" ? new WebSerialKiss(onFrame, onClose) : new WebBluetoothKiss(onFrame, onClose);
      await l.connect();
      linkRef.current = l; setLink(kind); fwdErr.current = false;
      toast(kind === "serial" ? "USB radio connected" : "Bluetooth radio connected");
    } catch (e) {
      const m = (e as Error).message || "";
      if (!/No port selected|chooser|cancel|User cancelled/i.test(m)) toast(`Could not connect: ${m}`);
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

  if (!serialOk && !bleOk) return (
    <p className="muted">Browser-direct RF needs <strong>Web Serial</strong> or <strong>Web Bluetooth</strong> —
      Chromium-based desktop/Android browsers over HTTPS. On other browsers, run the operator-local
      <span className="mono"> apps/ingest</span> instead. RX never implies trust — finds are still gated by the
      verification engine.</p>
  );

  return (
    <>
      <p className="muted">Plug in or pair a KISS TNC and decode RF here — no server. Frames heard on your own
        radio are Tier C (no independent IGate); verification is unchanged.</p>

      <div className="row gap-2">
        {link
          ? <button className="danger" onClick={disconnect}>Disconnect</button>
          : <>
              {serialOk && <button className="primary" onClick={() => connect("serial")} disabled={busy}>{busy ? "…" : "Connect USB radio"}</button>}
              {bleOk && <button onClick={() => connect("ble")} disabled={busy}>{busy ? "…" : "Connect Bluetooth"}</button>}
            </>}
        <span className="muted">{link ? `● live (${link === "ble" ? "BLE" : "USB"}) · ${count} frame${count === 1 ? "" : "s"}` : "not connected"}</span>
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
                    <input className="mono field-sm" placeholder="lat" value={bcn.lat} onChange={(e) => setBcn((b) => ({ ...b, lat: e.target.value }))} />
                    <input className="mono field-sm" placeholder="lon" value={bcn.lon} onChange={(e) => setBcn((b) => ({ ...b, lon: e.target.value }))} />
                    <button onClick={useMyLocation} title="Use my location">📍</button>
                  </div>
                  <input placeholder="comment (optional)" maxLength={43} value={bcn.comment} onChange={(e) => setBcn((b) => ({ ...b, comment: e.target.value }))} />
                  <div className="row end"><button className="primary" onClick={beacon} disabled={txBusy}>Beacon</button></div>
                  <h5>Message</h5>
                  <div className="row gap-2">
                    <input className="mono field-sm" placeholder="to" maxLength={9} value={msg.to} onChange={(e) => setMsg((m) => ({ ...m, to: e.target.value }))} />
                    <input placeholder="message" maxLength={67} value={msg.text} onChange={(e) => setMsg((m) => ({ ...m, text: e.target.value }))} />
                  </div>
                  <div className="row end"><button className="primary" onClick={sendMsg} disabled={txBusy}>Send</button></div>
                  <p className="muted fine">Each transmit is deliberate. Do not transmit without a valid licence for <span className="mono">{base}</span>.</p>
                </>}
              </>}
        </div>
      )}

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
