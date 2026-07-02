// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { decodeUltimeter, type UltimeterReading } from "@aprsweb/aprs";
import { WebSerialWeather, webSerialSupported } from "../rf/serialWeather.js";
import { submitWxReading } from "../api.js";
import { useFmt } from "../format.js";
import { useToast, Ico } from "../ui/index.js";

/**
 * Browser-direct PWS over Web Serial (docs/design/17 W4): read a Peet Bros / Ultimeter station on USB in the
 * browser, decode each line, and post the reading to your own station via the W1 ingest — no cloud
 * daemon. Chromium-only and session-bound; a non-supporting browser gets a one-line fallback (the
 * push URLs still work). Submissions are throttled to once a minute.
 */
const SUBMIT_MS = 60_000;
const BAUDS = [2400, 9600, 19200];

export function SerialWeather(props: { wxKey: string | null }) {
  const fmt = useFmt();
  const toast = useToast();
  const [supported] = useState(webSerialSupported());
  const [baud, setBaud] = useState(2400);
  const [connected, setConnected] = useState(false);
  const [reading, setReading] = useState<UltimeterReading | null>(null);
  const [sentAt, setSentAt] = useState<number | null>(null);
  const linkRef = useRef<WebSerialWeather | null>(null);
  const lastSubmit = useRef(0);
  const keyRef = useRef(props.wxKey);
  keyRef.current = props.wxKey;

  useEffect(() => () => { linkRef.current?.disconnect(); }, []); // disconnect on unmount

  async function maybeSubmit(r: UltimeterReading) {
    const key = keyRef.current;
    if (!key) return;
    const t = Date.now();
    if (t - lastSubmit.current < SUBMIT_MS) return;
    lastSubmit.current = t;
    try { await submitWxReading(key, r); setSentAt(Math.floor(t / 1000)); }
    catch (e) { console.warn(e); /* retry on the next packet */ }
  }

  async function connect() {
    try {
      const link = new WebSerialWeather((line) => {
        const r = decodeUltimeter(line);
        if (r) { setReading(r); void maybeSubmit(r); }
      }, baud);
      await link.connect();
      linkRef.current = link;
      setConnected(true);
      toast("Weather station connected");
    } catch (e) {
      if ((e as Error).name !== "NotFoundError") toast((e as Error).message); // NotFound = user cancelled the picker
    }
  }
  async function disconnect() {
    await linkRef.current?.disconnect();
    linkRef.current = null;
    setConnected(false);
  }

  if (!supported)
    return <p className="muted fine">Browser-direct weather needs Web Serial — use Chromium on desktop (no Safari/Firefox/iOS). Your station can still push via the URLs above.</p>;

  return (
    <div className="serial-wx">
      <p className="muted fine">Plug a Peet Bros / Ultimeter station into USB and read it directly in the browser — no daemon. Decoded readings post to your station once a minute.</p>
      <div className="row">
        <label>Baud <select value={baud} disabled={connected} onChange={(e) => setBaud(+e.target.value)}>
          {BAUDS.map((b) => <option key={b} value={b}>{b}</option>)}
        </select></label>
        {connected
          ? <button onClick={disconnect}>Disconnect</button>
          : <button className="primary" onClick={connect} disabled={!props.wxKey}>Connect station</button>}
      </div>
      {!props.wxKey && <p className="muted fine">Enable your weather station above first to get a push key.</p>}
      {connected && (
        <div className="serial-live mono">
          {reading ? (
            <>
              {reading.tempC != null && <span><Ico e="🌡 " c="T " />{fmt.temp(reading.tempC)}</span>}
              {reading.humidity != null && <span><Ico e="💧 " c="RH " />{reading.humidity}%</span>}
              {reading.windKn != null && <span><Ico e="🌬 " c="WND " />{fmt.speed(reading.windKn)}{reading.windDirDeg != null ? ` @ ${reading.windDirDeg}°` : ""}</span>}
              {reading.pressureHpa != null && <span>{reading.pressureHpa} hPa</span>}
              {reading.rainTodayMm != null && <span><Ico e="☔ " c="RN " />{reading.rainTodayMm} mm</span>}
            </>
          ) : <span className="muted">waiting for a packet…</span>}
        </div>
      )}
      {sentAt && <p className="muted fine">Last submitted {fmt.ago(sentAt)}.</p>}
    </div>
  );
}
