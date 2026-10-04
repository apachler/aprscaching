// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { getWxKey, issueWxKey, type WxKeyInfo } from "../api.js";
import { useFmt } from "../format.js";
import { Button, ErrorState, copyText, useConfirm, useLoad, useToast } from "../ui/index.js";
import { WxTxToggles } from "./WxTxToggles.js";
import { SerialWeather } from "./SerialWeather.js";

/**
 * Settings → Weather station (PWS): user-origination of their own weather. Issues a
 * push key and shows ready-to-paste URLs for the two formats consumer stations already speak —
 * Ecowitt "customized" push and Weather Underground "Rapidfire". Readings land under <call>-13.
 * Platform-only ingest: no RF licence needed (the licence gate is only for TX/CWOP).
 */
export function WeatherStation(props: { callsign: string }) {
  const confirmDialog = useConfirm();
  const toast = useToast();
  const fmt = useFmt();
  const signedIn = props.callsign.length >= 3;
  // Until the current key has been read there is no knowing whether issuing would replace one, so the
  // issue button waits for a successful read.
  const {
    data: info,
    setData: setInfo,
    error,
    reload,
  } = useLoad<WxKeyInfo | undefined>(
    () => (signedIn ? getWxKey() : Promise.resolve(undefined)),
    [signedIn, props.callsign],
  );
  const [busy, setBusy] = useState(false);

  async function issue() {
    if (!info) return;
    if (
      info?.key &&
      !(await confirmDialog({
        title: "Issue a new key?",
        message: "Your station stops reporting until you update its push URL with the new key.",
        confirmLabel: "Issue new key",
        danger: true,
      }))
    )
      return;
    setBusy(true);
    try {
      setInfo(await issueWxKey());
      toast(info?.key ? "New key issued" : "Weather station enabled");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const copy = async (v: string, what: string) => {
    toast((await copyText(v)) ? `${what} copied` : "Copy failed — select the text and copy manually");
  };

  if (!signedIn) return <p className="muted">Sign in to set up a weather station.</p>;
  if (!info)
    return error ? (
      <ErrorState onRetry={reload}>Couldn&apos;t load your weather station&apos;s key. Try again.</ErrorState>
    ) : (
      <p className="muted" aria-busy="true">
        Loading your weather station…
      </p>
    );
  return (
    <>
      <p className="muted">
        Push from your own weather station to the platform — it appears on the map as{" "}
        <span className="mono">{info?.station ?? `${props.callsign}-13`}</span>. Point your station at one of the URLs
        below; most consumer stations speak Ecowitt or Weather Underground out of the box. No amateur licence is needed
        for platform-only weather.
      </p>

      {!info?.key ? (
        <div className="row end mt-2">
          <Button variant="primary" onClick={issue} disabled={busy}>
            Enable weather station
          </Button>
        </div>
      ) : (
        <>
          <label>
            Ecowitt — custom server path <span className="muted">(Protocol: Ecowitt; Path: as below)</span>
            <span className="copyrow">
              <input
                className="mono"
                readOnly
                value={info.ecowittPath ?? ""}
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                variant="icon-subtle"
                aria-label="Copy Ecowitt URL"
                onClick={() => void copy(info.ecowittPath ?? "", "Ecowitt URL")}
              >
                copy
              </Button>
            </span>
          </label>
          <label>
            Weather Underground — Rapidfire URL
            <span className="copyrow">
              <input className="mono" readOnly value={info.wuUrl ?? ""} onFocus={(e) => e.currentTarget.select()} />
              <Button
                variant="icon-subtle"
                aria-label="Copy Weather Underground URL"
                onClick={() => void copy(info.wuUrl ?? "", "WU URL")}
              >
                copy
              </Button>
            </span>
          </label>
          <p className="muted fine">Last reading: {info.lastSeen ? fmt.dateTime(info.lastSeen) : "—"}.</p>
          <h5 className="mt-2">Transmit (optional)</h5>
          <p className="muted fine">
            Platform ingest above needs no licence. Transmitting to APRS-IS or CWOP does — it's gated on a verified
            callsign and off by default.
          </p>
          <WxTxToggles txIs={info.txIs} txCwop={info.txCwop} verified={info.verified} />
          <h5 className="mt-2">Browser-direct (Web Serial)</h5>
          <SerialWeather wxKey={info.key} />
          <div className="row end mt-2">
            <Button onClick={issue} disabled={busy}>
              Re-issue key
            </Button>
          </div>
        </>
      )}
    </>
  );
}
