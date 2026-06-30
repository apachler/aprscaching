import { useEffect, useRef, useState } from "react";
import { WebSerialKiss, webSerialSupported, type RfFrame } from "./kiss.js";
import { ingestPackets } from "../api.js";
import { useFmt } from "../format.js";
import { Row, Switch, EmptyState, Advanced, useToast } from "../ui/index.js";

const FWD_KEY = "acs.rf.forward"; // { url, secret } for the operator-local / self-host ingest path

/**
 * Workbench → RF (browser): connect a USB KISS TNC over Web Serial and decode live RF here, no
 * server needed (docs/16 H1). Optionally forward to a self-hosted gateway's /ingest. Chromium-only;
 * shows a clear fallback elsewhere.
 */
export function RfBrowser() {
  const fmt = useFmt();
  const toast = useToast();
  const supported = webSerialSupported();
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [frames, setFrames] = useState<RfFrame[]>([]);
  const [count, setCount] = useState(0);
  const [forward, setForward] = useState<{ url: string; secret: string } | null>(() => {
    try { return JSON.parse(localStorage.getItem(FWD_KEY) || "null"); } catch { return null; }
  });
  const [fwdOn, setFwdOn] = useState(false);
  const kiss = useRef<WebSerialKiss | null>(null);
  const fwd = useRef(forward); fwd.current = forward;
  const fwdOnRef = useRef(fwdOn); fwdOnRef.current = fwdOn;

  useEffect(() => () => { void kiss.current?.disconnect(); }, []);

  async function connect() {
    setBusy(true);
    try {
      const k = new WebSerialKiss(
        (f) => {
          setFrames((prev) => [f, ...prev].slice(0, 100));
          setCount((n) => n + 1);
          if (fwdOnRef.current && fwd.current?.secret) {
            ingestPackets([f.packet], fwd.current.secret, fwd.current.url || undefined).catch(() => {/* shown once below */});
          }
        },
        (err) => { setConnected(false); if (err) toast(`Radio disconnected: ${err.message}`); },
      );
      await k.connect();
      kiss.current = k;
      setConnected(true);
      toast("Radio connected");
    } catch (e) {
      const m = (e as Error).message || "";
      if (!/No port selected|cancel/i.test(m)) toast(`Could not connect: ${m}`);
    } finally { setBusy(false); }
  }
  async function disconnect() { await kiss.current?.disconnect(); kiss.current = null; setConnected(false); }

  function saveForward(url: string, secret: string) {
    const v = secret ? { url: url.trim(), secret: secret.trim() } : null;
    setForward(v);
    try { v ? localStorage.setItem(FWD_KEY, JSON.stringify(v)) : localStorage.removeItem(FWD_KEY); } catch { /* ignore */ }
  }

  if (!supported) return (
    <p className="muted">Browser-direct RF needs <strong>Web Serial</strong> — available in Chromium-based
      desktop browsers (Chrome, Edge) over HTTPS. On other browsers, run the operator-local
      <span className="mono"> apps/ingest</span> instead. RX never implies trust — finds are still gated by the
      verification engine.</p>
  );

  return (
    <>
      <p className="muted">Plug in a USB KISS TNC and decode RF here — no server. Frames heard on your own
        radio are Tier C (no independent IGate); verification is unchanged.</p>
      <div className="row gap-2">
        {connected
          ? <button className="danger" onClick={disconnect}>Disconnect</button>
          : <button className="primary" onClick={connect} disabled={busy}>{busy ? "Connecting…" : "Connect a radio"}</button>}
        <span className="muted">{connected ? `● live · ${count} frame${count === 1 ? "" : "s"}` : "not connected"}</span>
      </div>

      <Row label="Forward to my gateway" help={forward?.secret ? "Decoded frames POST to your gateway /ingest" : "Set a gateway URL + ingest secret below to enable"}>
        <Switch label="Forward to my gateway" checked={fwdOn} disabled={!forward?.secret}
                onChange={(v) => setFwdOn(v)} />
      </Row>
      <Advanced label="Gateway forwarding (self-host)">
        <label>Gateway base URL <input className="mono" defaultValue={forward?.url ?? ""} placeholder="https://your-gateway"
          onBlur={(e) => saveForward(e.target.value, forward?.secret ?? "")} /></label>
        <label>Ingest secret <input className="mono" type="password" defaultValue={forward?.secret ?? ""} placeholder="INGEST_SECRET"
          onBlur={(e) => saveForward(forward?.url ?? "", e.target.value)} /></label>
        <p className="muted fine">Stored only in this browser. This is the single-operator / off-grid path; a
          multi-operator shared gateway should use per-operator signed keys (a later step).</p>
      </Advanced>

      <h4>Live RX</h4>
      {frames.length === 0
        ? <EmptyState>{connected ? "Listening… frames appear as your radio hears them." : "Connect a radio to see live packets."}</EmptyState>
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
