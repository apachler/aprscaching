// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useReducer, useState } from "react";
import { webSerialSupported, webBluetoothSupported } from "./kiss.js";
import { webAudioSupported } from "./extralinks.js";
import { encodeAprsPosition, encodeAprsMessage, ackReply, syncBackBatch, type LocalMessage } from "@aprscaching/aprs";
import { fieldStation } from "./fieldStation.js";
import { radioLink, useRadioLink } from "./RadioLinkHost.js";
import { LINK_LABEL, type LinkKind } from "./radioLink.js";
import { ingestPackets, ingestSigned, registerKey, recordSentMessage } from "../api.js";
import { nextMsgNo } from "./msgNo.js";
import { devicePublicKey } from "../crypto.js";
import { useFmt } from "../format.js";
import { NAV_MAX_AGE_MS } from "../geo/location.js";
import { LocateStatus, useLocate } from "../geo/useLocate.js";
import {
  Button,
  Row,
  Switch,
  EmptyState,
  Disclosure,
  useToast,
  useConfirm,
  Icon,
  Segmented,
  InfoTip,
  ManualLink,
} from "../ui/index.js";
import { TERMS } from "../terms.js";

/**
 * Settings → My radio (browser): connect a KISS TNC over Web Serial (USB) or Web Bluetooth (BLE), a radio's audio
 * through the soundcard, or a Meshtastic node, and decode live RF here, no server. Optionally forward to a gateway
 * — signed with your device key for a public gateway, or with an ingest secret for self-host. This is a view over
 * the app-wide radio link (RadioLinkHost.tsx): closing Settings or collapsing the group keeps the radio connected.
 */
export function RfBrowser(props: { callsign: string; verified: boolean }) {
  const confirmDialog = useConfirm();
  const fmt = useFmt();
  const toast = useToast();
  const loc = useLocate();
  const serialOk = webSerialSupported();
  const bleOk = webBluetoothSupported();
  const audioOk = webAudioSupported();
  const signedIn = props.callsign.length >= 3;
  const base = props.callsign.toUpperCase().split("-")[0] ?? "";

  const { link, busy, frames, count, fwdOn, mode, txOn, ssid, gatewayUrl, secret, sent } = useRadioLink();
  const rxOnlyLink = link === "audio" || link === "mesh";
  const [bcn, setBcn] = useState({ lat: "", lon: "", symbol: "/>", comment: "" });
  const [msg, setMsg] = useState({ to: "", text: "" });
  const [txBusy, setTxBusy] = useState(false);
  const txCall = radioLink.txCall();

  // Field station: re-render when the local sink updates (live stations + inbox).
  const [, forceField] = useReducer((n: number) => n + 1, 0);
  useEffect(() => fieldStation.subscribe(() => forceField()), []);

  /** ACK a message heard for us over the radio — gated on callsign control-verification, reuses the KISS TX path. */
  async function ackMessage(mm: LocalMessage) {
    const info = ackReply(mm, props.callsign);
    if (!info || !radioLink.canTransmit()) return;
    setTxBusy(true);
    try {
      await radioLink.transmit({ src: txCall, dst: "APZACG", path: ["WIDE1-1"], payload: info }, "My radio");
      toast(`ACK ${mm.msgNo} → ${mm.from}`);
    } catch (e) {
      toast(`TX failed: ${(e as Error).message}`);
    } finally {
      setTxBusy(false);
    }
  }

  /** Sync-back: replay locally-heard receptions to a gateway once online (via the forward path). */
  async function syncBack() {
    const heard = fieldStation.heardForSync();
    const keep = new Set(
      syncBackBatch(
        heard.map((h) => ({ raw: h.raw, at: h.at })),
        props.callsign,
      ).map((h) => h.raw),
    );
    const packets = heard.filter((h) => keep.has(h.raw)).map((h) => h.packet);
    if (!packets.length) {
      toast("Nothing new to sync.");
      return;
    }
    const send =
      mode === "signed" && signedIn
        ? ingestSigned(packets, props.callsign)
        : secret
          ? ingestPackets(packets, secret, gatewayUrl || undefined)
          : null;
    if (!send) {
      toast("Turn on forwarding to a gateway first (above).");
      return;
    }
    try {
      await send;
      fieldStation.clearHeard();
      toast(`Synced ${packets.length} heard frame(s).`);
    } catch (e) {
      toast(`Sync failed: ${(e as Error).message}`);
    }
  }

  async function enableForward(on: boolean) {
    if (on && mode === "signed" && signedIn) {
      const key = await devicePublicKey();
      if (!key) {
        toast("This browser can't sign (needs Ed25519). Use the self-host secret instead.");
        return;
      }
      await registerKey({ callsign: props.callsign, publicKey: key, label: "browser RF" }).catch(() => {}); // ensure the key is registered
    }
    radioLink.setForward(on);
  }

  // Transmit, gated on callsign control-verification and this session's consent; every send is a deliberate,
  // confirmed action.
  async function tx(payload: string, what: string): Promise<boolean> {
    if (!radioLink.canTransmit()) return false;
    setTxBusy(true);
    try {
      await radioLink.transmit({ src: txCall, dst: "APRS", path: ["WIDE1-1"], payload }, "My radio");
      toast(`Transmitted: ${what}`);
      return true;
    } catch (e) {
      toast(`TX failed: ${(e as Error).message}`);
      return false;
    } finally {
      setTxBusy(false);
    }
  }
  async function beacon() {
    const lat = Number(bcn.lat),
      lon = Number(bcn.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      toast("Enter a valid latitude and longitude");
      return;
    }
    if (
      !(await confirmDialog({
        title: "Transmit position beacon?",
        message: `Keys your radio and transmits a position beacon as ${txCall}.`,
        confirmLabel: "Transmit",
      }))
    )
      return;
    await tx(encodeAprsPosition(lat, lon, bcn.symbol || "/>", bcn.comment), "position");
  }
  async function sendMsg() {
    if (!msg.to.trim() || !msg.text.trim()) {
      toast("Enter a recipient and a message");
      return;
    }
    if (
      !(await confirmDialog({
        title: `Transmit message to ${msg.to.toUpperCase()}?`,
        message: `Keys your radio and transmits as ${txCall}.`,
        confirmLabel: "Transmit",
      }))
    )
      return;
    // a numbered message asks the addressee's station to acknowledge it
    const msgNo = nextMsgNo();
    if (await tx(encodeAprsMessage(msg.to, msg.text, msgNo), `message to ${msg.to.toUpperCase()}`))
      void recordSentMessage({ from: txCall, to: msg.to.trim().toUpperCase(), text: msg.text.trim(), msgNo }).catch(
        () => {}, // the Messages list misses it; the message itself went out
      );
  }
  async function fillMyLocation() {
    const got = await loc.locate(NAV_MAX_AGE_MS);
    if ("fix" in got) setBcn((b) => ({ ...b, lat: got.fix.lat.toFixed(5), lon: got.fix.lon.toFixed(5) }));
  }

  if (!serialOk && !bleOk && !audioOk)
    return (
      <p className="muted">
        Connecting a radio here needs <strong>Web Serial</strong>, <strong>Web Bluetooth</strong> or{" "}
        <strong>Web Audio</strong>: a Chromium-based browser (Chrome, Edge) on a computer or an Android phone, over
        HTTPS. Without one, a small computer beside the radio feeds the instance instead:{" "}
        <ManualLink page="run/radios/ingest-box">set up an ingest box</ManualLink>. What a radio hears never makes a
        find verified on its own.
      </p>
    );

  const heardN = fieldStation.heardForSync().length;
  // forwarding matters once there is something to forward: a live radio, or frames heard off-grid
  const canForward = link != null || heardN > 0;
  const connectBtn = (kind: LinkKind, label: string, hint: string, primary = false) => (
    <Button
      variant={primary ? "primary" : undefined}
      onClick={() => void radioLink.connect(kind)}
      disabled={busy}
      hint={hint}
    >
      {busy ? "…" : label}
    </Button>
  );

  return (
    <>
      <p className="muted">
        Hear your own radio in this browser — no server needed. The radio stays connected while you use the rest of the
        app, until you disconnect it or close the page.
      </p>

      <div className="row gap-2">
        {link ? (
          <Button variant="danger" onClick={() => void radioLink.disconnect()}>
            Disconnect
          </Button>
        ) : (
          <>
            {serialOk && connectBtn("serial", "Connect USB radio", "Pick the USB serial port of a KISS TNC", true)}
            {bleOk && connectBtn("ble", "Connect Bluetooth", "Pair a Bluetooth KISS TNC, such as a Mobilinkd")}
            {audioOk &&
              connectBtn(
                "audio",
                "Soundcard AFSK",
                "Decode 1200-baud APRS audio from your radio through the sound card, with no TNC",
              )}
            {serialOk && connectBtn("mesh", "Meshtastic node", "Read the positions a Meshtastic node hears, over USB")}
          </>
        )}
        <span className="muted" role="status">
          {link ? `● live (${LINK_LABEL[link]}) · ${count} frame${count === 1 ? "" : "s"}` : "not connected"}
        </span>
      </div>
      {(!serialOk || !bleOk) && (
        <p className="muted fine">
          {!serialOk && !bleOk
            ? "USB radios, Bluetooth TNCs and Meshtastic nodes need Web Serial and Web Bluetooth, which only Chromium-based browsers (Chrome, Edge) offer"
            : !serialOk
              ? "USB radios and Meshtastic nodes need Web Serial, which only Chromium-based desktop browsers (Chrome, Edge) offer"
              : "Bluetooth TNCs need Web Bluetooth, which only Chromium-based browsers (Chrome, Edge) offer"}
          {audioOk && !serialOk && !bleOk ? ", so this browser can use only the soundcard modem. " : ". "}
          <ManualLink page="shack/my-radio" anchor="what-you-need">
            What you need
          </ManualLink>
        </p>
      )}

      <Disclosure label="What your radio can verify">
        <p className="muted fine m-0">
          A KISS TNC over USB or Bluetooth, a radio&apos;s audio through the soundcard, or a Meshtastic/LoRa node all
          work. What this browser hears helps you see the band, but it never verifies a find: only this instance&apos;s
          own receiving station can make a find Radio-verified.
        </p>
      </Disclosure>

      {canForward ? (
        <>
          <Row
            label="Forward to a gateway"
            help={
              mode === "signed"
                ? "Signed with your device key (public gateway, no secret)"
                : "With an ingest secret (self-host)"
            }
          >
            <Switch
              label="Forward to a gateway"
              checked={fwdOn}
              onChange={(v) => {
                void enableForward(v);
              }}
            />
          </Row>
          {fwdOn && (
            <>
              <Row label="Auth" help="How the gateway knows the frames come from you">
                <Segmented
                  label="Auth"
                  value={mode}
                  onChange={(m) => radioLink.setMode(m)}
                  options={[
                    {
                      value: "signed",
                      label: `signed${signedIn ? ` (${props.callsign})` : " — sign in to enable"}`,
                      disabled: !signedIn,
                      title: signedIn ? undefined : "Sign in to forward under your own callsign",
                    },
                    { value: "secret", label: "secret (self-host)" },
                  ]}
                />
              </Row>
              {mode === "secret" && (
                <>
                  <label>
                    Gateway base URL{" "}
                    <input
                      className="mono"
                      defaultValue={gatewayUrl}
                      placeholder="https://your-gateway"
                      onBlur={(e) => radioLink.setGatewayUrl(e.target.value)}
                    />
                  </label>
                  <label>
                    Ingest secret{" "}
                    <input
                      className="mono"
                      type="password"
                      defaultValue={secret}
                      placeholder="INGEST_SECRET"
                      onBlur={(e) => radioLink.setSecret(e.target.value)}
                    />
                  </label>
                  <p className="muted fine">
                    {secret
                      ? "Kept in memory for this session only; enter it again after a reload."
                      : "Forwarding starts once the ingest secret is set. It is kept in memory for this session only."}
                  </p>
                </>
              )}
            </>
          )}
        </>
      ) : (
        <p className="muted fine">Connect a radio to forward what it hears to a gateway.</p>
      )}

      {link && (
        <div className="tx-block">
          <h4>Transmit</h4>
          {!props.verified ? (
            <p className="muted">
              Transmit is for <strong>licensed, control-verified</strong> operators only — verify your callsign in
              Settings → Account to enable it. (RX is always available; trust is unaffected.)
            </p>
          ) : rxOnlyLink ? (
            <p className="muted">This link only receives. Connect a USB or Bluetooth TNC to transmit.</p>
          ) : (
            <>
              <Row
                label="Transmit in this tab"
                help={
                  txOn
                    ? `Allowed as ${txCall} until you close this tab, disconnect or sign out. Switch off to stop.`
                    : "Receive only. Switching on asks once, for this tab only."
                }
              >
                <Switch
                  label="Transmit in this tab"
                  checked={txOn}
                  onChange={(v) => (v ? void radioLink.requestTx() : radioLink.revokeTx())}
                />
              </Row>
              {txOn && (
                <>
                  <Row
                    label={
                      <>
                        TX callsign <InfoTip text={TERMS.ssid} label="What is an SSID?" />
                      </>
                    }
                  >
                    <span className="mono">{base}-</span>
                    <input
                      className="field-sm mono"
                      value={ssid}
                      inputMode="numeric"
                      maxLength={2}
                      onChange={(e) => radioLink.setSsid(e.target.value)}
                      aria-label="SSID"
                    />
                    <span className="muted"> → {txCall}</span>
                  </Row>
                  <p className="muted fine">
                    A different SSID ends this tab&apos;s consent; switching transmit on asks again.
                  </p>
                  <h5>Beacon position</h5>
                  <div className="row gap-2">
                    <input
                      className="mono field-sm"
                      placeholder="lat"
                      aria-label="Latitude"
                      value={bcn.lat}
                      onChange={(e) => setBcn((b) => ({ ...b, lat: e.target.value }))}
                    />
                    <input
                      className="mono field-sm"
                      placeholder="lon"
                      aria-label="Longitude"
                      value={bcn.lon}
                      onChange={(e) => setBcn((b) => ({ ...b, lon: e.target.value }))}
                    />
                    <Button
                      onClick={() => void fillMyLocation()}
                      disabled={!!loc.waiting}
                      hint="Fill in your current location"
                      aria-label="Use my location"
                    >
                      <Icon name="place" cp437="@" className="lead-ic" />
                    </Button>
                  </div>
                  <LocateStatus waiting={loc.waiting} problem={loc.problem} onCancel={loc.cancel} />
                  <input
                    placeholder="comment (optional)"
                    aria-label="Beacon comment"
                    maxLength={43}
                    value={bcn.comment}
                    onChange={(e) => setBcn((b) => ({ ...b, comment: e.target.value }))}
                  />
                  <div className="row end">
                    <Button variant="primary" onClick={beacon} disabled={txBusy}>
                      Beacon
                    </Button>
                  </div>
                  <h5>Message</h5>
                  <div className="row gap-2">
                    <input
                      className="mono field-sm"
                      placeholder="to"
                      aria-label="Message recipient"
                      maxLength={9}
                      value={msg.to}
                      onChange={(e) => setMsg((m) => ({ ...m, to: e.target.value }))}
                    />
                    <input
                      placeholder="message"
                      aria-label="Message text"
                      maxLength={67}
                      value={msg.text}
                      onChange={(e) => setMsg((m) => ({ ...m, text: e.target.value }))}
                    />
                  </div>
                  <div className="row end">
                    <Button variant="primary" onClick={sendMsg} disabled={txBusy}>
                      Send
                    </Button>
                  </div>
                  <p className="muted fine">
                    Each transmit is deliberate. Do not transmit without a valid licence for{" "}
                    <span className="mono">{base}</span>.
                  </p>
                </>
              )}
            </>
          )}
        </div>
      )}

      <div className="tx-log-block">
        <div className="row between">
          <h4>
            Recent transmissions <span className="muted fine">this tab only</span>
          </h4>
          <Button
            onClick={() => radioLink.clearSent()}
            disabled={sent.length === 0}
            hint="Empty this list. It lives in this tab's memory only and is never sent to the instance."
          >
            Clear
          </Button>
        </div>
        {sent.length === 0 ? (
          <EmptyState>Nothing transmitted in this session.</EmptyState>
        ) : (
          <ul className="logs tx-log">
            {sent.map((t) => (
              <li key={t.id}>
                <span className="mono">
                  <strong>{t.src}</strong>&gt;{t.dst}
                  {t.path.length > 0 && `,${t.path.join(",")}`}
                </span>
                <span className="muted">
                  {" "}
                  · {t.feature} · <time dateTime={new Date(t.at).toISOString()}>{fmt.time(t.at / 1000)}</time>
                </span>
                <div className="comment mono">{t.summary}</div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Field station: local RF -> live stations + inbox, no gateway needed. */}
      {(() => {
        const stations = fieldStation.liveStations();
        const inbox = fieldStation.inbox();
        return stations.length > 0 || inbox.length > 0 ? (
          <div className="field-station">
            <div className="row between">
              <h4>
                Field station <span className="muted fine">off-grid · no gateway</span>
              </h4>
              <Button
                onClick={syncBack}
                disabled={heardN === 0}
                hint="Send the frames heard here while offline to a gateway, now that you are online"
              >
                Sync {heardN} heard
              </Button>
            </div>
            <div className="fs-cols">
              <div>
                <div className="ulabel">
                  Stations heard <span className="muted fine">({stations.length})</span>
                </div>
                {stations.length === 0 ? (
                  <EmptyState>None yet.</EmptyState>
                ) : (
                  <ul className="logs">
                    {stations.slice(0, 30).map((s) => (
                      <li key={s.callsign}>
                        <span className="mono">
                          <strong>{s.callsign}</strong>
                        </span>
                        <span className="muted">
                          {" "}
                          · {s.lat.toFixed(3)},{s.lon.toFixed(3)}
                        </span>
                        {s.kind !== "station" && <span className="muted"> · {s.kind}</span>}
                        <span className="muted"> · {fmt.ago(s.heardAt / 1000)}</span>
                        {s.comment && <div className="comment mono">{s.comment.slice(0, 60)}</div>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <div className="ulabel">
                  Local inbox <span className="muted fine">({inbox.length})</span>
                </div>
                {inbox.length === 0 ? (
                  <EmptyState>No messages.</EmptyState>
                ) : (
                  <ul className="logs">
                    {inbox.slice(0, 30).map((mm: LocalMessage, i) => (
                      <li key={`${mm.at}-${i}`}>
                        <span className="mono">
                          <strong>{mm.from}</strong>
                          {mm.ack ? " (ack)" : ""} &rarr; {mm.to}
                        </span>
                        <span className="muted"> · {fmt.ago(mm.at / 1000)}</span>
                        <div className="comment mono">{mm.text.slice(0, 80)}</div>
                        {props.verified && txOn && link && ackReply(mm, props.callsign) && (
                          <Button className="fine" onClick={() => ackMessage(mm)} disabled={txBusy}>
                            ACK {mm.msgNo}
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        ) : null;
      })()}

      <h4>Live RX</h4>
      {frames.length === 0 ? (
        <EmptyState>
          {link ? "Listening… frames appear as your radio hears them." : "Connect a radio to see live packets."}
        </EmptyState>
      ) : (
        <ul className="logs rf-rx">
          {frames.map((f, i) => (
            <li key={`${f.at}-${i}`}>
              <span className="mono">
                <strong>{f.frame.src}</strong>
                {f.frame.dst ? `>${f.frame.dst}` : ""}
              </span>
              <span className="muted"> {f.data.kind}</span>
              {"lat" in f.data && typeof (f.data as { lat?: number }).lat === "number" && (
                <span className="muted">
                  {" "}
                  · {(f.data as { lat: number }).lat.toFixed(3)},{(f.data as { lon: number }).lon.toFixed(3)}
                </span>
              )}
              <span className="muted"> · {fmt.ago(f.at / 1000)}</span>
              <div className="comment mono">{f.frame.payload.slice(0, 80)}</div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
