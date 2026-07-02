import { useEffect, useState } from "react";
import type maplibregl from "maplibre-gl";
import { getInstance, getSource, sourceLinkUrl, exportAccount, deleteAccount, getNotifyPrefs, setNotifyPrefs, type SourceInfo } from "../api.js";
import { signAccountAction } from "../crypto.js";
import {
  useFmt, browserLocale, browserTimeZone, type LocaleSettings,
} from "../format.js";
import { Panel, Group, Row, Advanced, Switch, Ico } from "../ui/index.js";
import { AccountSettings } from "./AccountSettings.js";
import { ConnectionsSettings } from "./ConnectionsSettings.js";
import { Watchlist } from "../workbench/Watchlist.js";
import { pushSupported, pushSubscribed, enablePush, disablePush } from "../push.js";
import { ProfileEditor } from "../profile/ProfileEditor.js";
import { WeatherStation } from "../profile/WeatherStation.js";
import { MyStations } from "../profile/MyStations.js";
import { SupportSettings } from "./SupportSettings.js";

type Sess = { callsign: string; verified: boolean; email: string | null; signedIn: boolean; signOut: () => void; refresh: () => void };

/** Settings — account, connections/network, locale/units, GDPR data tools, and credits. Grouped + searchable. */
export function SettingsPanel(props: {
  settings: LocaleSettings; onApply: (s: LocaleSettings) => void; callsign: string; verified: boolean;
  map: maplibregl.Map | null; onFly: (lat: number, lon: number) => void;
  session: Sess; onSignIn: () => void; onClose: () => void;
}) {
  const s = props.settings;
  const fmt = useFmt();
  const [gdpr, setGdpr] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<{ digest: boolean; hasEmail: boolean; pushConfigured: boolean } | null>(null);
  const [pushState, setPushState] = useState<"loading" | "unsupported" | "off" | "on" | "denied" | "error" | "unconfigured">("loading");
  useEffect(() => {
    if (!props.session.signedIn) return;
    getNotifyPrefs().then(setPrefs).catch(() => {});
    (async () => { setPushState(!pushSupported() ? "unsupported" : (await pushSubscribed()) ? "on" : "off"); })();
  }, [props.session.signedIn]);
  async function togglePush() {
    if (pushState === "on") { await disablePush(); setPushState("off"); }
    else { setPushState("loading"); setPushState(await enablePush()); }
  }

  async function exportData() {
    setGdpr("Preparing your export…");
    try {
      const inst = await getInstance();
      const auth = await signAccountAction("export", props.callsign, inst);
      if (!auth) { setGdpr("This browser can't sign (needs Ed25519). Try a recent Chrome/Firefox/Safari."); return; }
      const data = await exportAccount(props.callsign, auth);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = document.createElement("a"); a.href = url; a.download = `aprscaching-${props.callsign}.json`; a.click();
      URL.revokeObjectURL(url); setGdpr("Export downloaded.");
    } catch (e) { setGdpr((e as Error).message); }
  }
  async function deleteData() {
    if (!confirm(`Permanently erase ${props.callsign}? Your finds are anonymised and your account, keys and personal data are deleted. This cannot be undone.`)) return;
    setGdpr("Erasing…");
    try {
      const inst = await getInstance();
      const auth = await signAccountAction("delete", props.callsign, inst);
      if (!auth) { setGdpr("This browser can't sign (needs Ed25519)."); return; }
      await deleteAccount(props.callsign, auth);
      setGdpr("Your account and personal data were erased.");
    } catch (e) { setGdpr((e as Error).message); }
  }
  const [q, setQ] = useState("");
  const match = (title: string, ...kw: string[]) => !q || (title + " " + kw.join(" ")).toLowerCase().includes(q.toLowerCase());
  return (
    <Panel title={<><Ico e="⚙ " />Settings</>} onClose={props.onClose}>
      <label className="srch"><span className="srch-ic">⌕</span>
        <input value={q} placeholder="Search settings…" onChange={(e) => setQ(e.target.value)} aria-label="Search settings" />
      </label>

      {match("Account callsign callsigns identity verify SSID licence sign in passkey email") && (
        <AccountSettings session={props.session} onSignIn={props.onSignIn} />
      )}

      {match("Display appearance theme units measurement") && (
        <Group title="Display">
          <Row label="Theme" help="Cogmind = the late-90s green-screen flip">
            <div className="seg">{(["modern", "cogmind"] as const).map((t) => (
              <button key={t} className={s.theme === t ? "on" : ""} onClick={() => props.onApply({ ...s, theme: t })}>{t}</button>
            ))}</div>
          </Row>
          <Row label="Units" help="distances, speed, temperature">
            <div className="seg">{(["metric", "imperial"] as const).map((u) => (
              <button key={u} className={s.units === u ? "on" : ""} onClick={() => props.onApply({ ...s, units: u })}>{u}</button>
            ))}</div>
          </Row>
          {s.theme === "cogmind" && (
            <Row label="CRT effect" help="Scanlines + phosphor glow. Off by default; disabled when reduce-motion is on.">
              <Switch label="CRT effect" checked={s.crt} onChange={(v) => props.onApply({ ...s, crt: v })} />
            </Row>
          )}
        </Group>
      )}

      {props.session.signedIn && match("profile display name locator grid bio links avatar contact public") && (
        <Group title="Profile" defaultOpen={false}>
          <ProfileEditor callsign={props.callsign} />
        </Group>
      )}

      {props.session.signedIn && match("weather station PWS home Ecowitt Weather Underground WU temperature wind rain sensor") && (
        <Group title="Home weather station" status="PWS" defaultOpen={false}>
          <WeatherStation callsign={props.callsign} />
        </Group>
      )}

      {props.session.signedIn && match("my stations operated callsign SSID digipeater igate node relay mountain remote location registry") && (
        <Group title="My stations" defaultOpen={false}>
          <MyStations callsign={props.callsign} />
        </Group>
      )}

      {props.session.signedIn && match("my radio browser RF Web Serial BLE KISS TNC bridge station") && (
        <Group title="My radio (browser)" status="RF bridge" defaultOpen={false}>
          <ConnectionsSettings callsign={props.callsign} verified={props.verified} />
        </Group>
      )}

      {props.session.signedIn && match("notifications alerts email digest push watchlist watch callsign") && (
        <Group title="Notifications" defaultOpen={false}>
          <Row label="Email digest" help={prefs?.hasEmail ? "Batched watchlist alerts, emailed to you" : "Add an email to your account to receive a digest"}>
            <Switch label="Email digest" checked={!!prefs?.digest} disabled={!prefs?.hasEmail}
                    onChange={(v) => { setNotifyPrefs(v).then(() => setPrefs((p) => (p ? { ...p, digest: v } : p))).catch(() => {}); }} />
          </Row>
          <Row label="Browser push" help="A notification when a watched callsign is active">
            {!prefs?.pushConfigured
              ? <span className="muted">Not enabled on this instance</span>
              : pushState === "unsupported"
                ? <span className="muted">Not supported in this browser</span>
                : <button onClick={togglePush} disabled={pushState === "loading"}>{pushState === "on" ? "Disable" : "Enable"}</button>}
          </Row>
          {pushState === "denied" && <p className="muted error">Notifications are blocked — allow them in your browser settings, then try again.</p>}
          {pushState === "error" && <p className="muted error">Could not enable push. On iPhone, install the app to your home screen first.</p>}
          <h4 className="set-subh">Watchlist</h4>
          <Watchlist callsign={props.callsign} onFly={props.onFly} />
        </Group>
      )}

      {match("Locale region time zone language date number format") && (
        <Group title="Locale & time" status={`${fmt.resolvedLocale} · ${fmt.resolvedTimeZone}`} defaultOpen={false}>
          <p className="muted">Blank follows the browser.</p>
          <Advanced label="Override locale & time zone">
            <label>Locale<input value={s.locale} placeholder={`browser (${browserLocale()})`} onChange={(e) => props.onApply({ ...s, locale: e.target.value.trim() })} /></label>
            <label>Time zone<input value={s.timeZone} placeholder={`browser (${browserTimeZone()})`} onChange={(e) => props.onApply({ ...s, timeZone: e.target.value.trim() })} /></label>
          </Advanced>
          <Row label="Preview"><span className="mono">{fmt.distance(1234)} · {fmt.speed(36)} · {fmt.temp(18)}</span></Row>
        </Group>
      )}

      {match("Your data export erase delete GDPR DSGVO privacy account") && (
        <Group title="Your data" status="GDPR" defaultOpen={false}>
          {props.callsign.length < 3 ? <p className="muted">Set your callsign (top bar) to export or erase your data.</p> : (<>
            <p className="muted">Signed with your device key for <span className="mono">{props.callsign}</span>. Export gives you a full copy; erase anonymises your finds and removes your account, keys and personal data.</p>
            <div className="row">
              <button onClick={exportData}>Export my data</button>
              <button className="danger" onClick={deleteData}>Erase my account</button>
            </div>
            {gdpr && <p className="muted mt-2">{gdpr}</p>}
          </>)}
        </Group>
      )}

      {match("support donate donation supporter sponsor ledger transparency liberapay kofi patreon contribute") && (
        <Group title="Support the project" status="♥" defaultOpen={false}>
          <SupportSettings signedIn={props.session.signedIn} />
        </Group>
      )}

      {match("About credits attribution Bruninga WB4APR APRS trademark licence open source") && (
        <Group title="About & credits" defaultOpen={false}>
          <p className="muted">APRScaching is a caching-first web workbench by <span className="mono">OE8APR</span>.</p>
          <p className="muted">APRS — the Automatic Packet Reporting System — was created by the late
            {" "}<strong>Bob Bruninga, WB4APR</strong> (1948–2022). “APRS” is his trademark. This is an
            independent, unofficial implementation built from open specifications (APRS101, APRS-IS) and
            is not affiliated with, sponsored by, or endorsed by him or his estate.</p>
          <p className="muted">Maps © OpenStreetMap contributors, rendered with MapLibre. Built on open
            source; the APRScaching game and this app are the author’s own work.</p>
          <SourceLink />
        </Group>
      )}
    </Panel>
  );
}

/** AGPL §13 (ADR-3): a visible link to the exact source this instance is running. */
function SourceLink() {
  const [src, setSrc] = useState<SourceInfo | null>(null);
  useEffect(() => { getSource().then(setSrc).catch(() => {}); }, []);
  const short = src?.commit ? src.commit.slice(0, 8) : src?.tag ?? null;
  return (
    <p className="muted fine">
      <a href={sourceLinkUrl} target="_blank" rel="noreferrer">Source code</a>
      {" — "}{src?.license ?? "AGPL-3.0-or-later"}{short ? <> · <span className="mono">{short}</span></> : null}.
      {" "}This is the AGPL §13 link to the source this instance runs.
    </p>
  );
}
