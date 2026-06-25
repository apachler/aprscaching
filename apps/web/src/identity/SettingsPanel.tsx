import { useState } from "react";
import { getInstance, exportAccount, deleteAccount } from "../api.js";
import { signAccountAction } from "../crypto.js";
import {
  useFmt, browserLocale, browserTimeZone, type LocaleSettings,
} from "../format.js";
import { Panel, Group, Row, Advanced } from "../ui/index.js";
import { AccountSettings } from "./AccountSettings.js";

type Sess = { callsign: string; verified: boolean; email: string | null; signedIn: boolean; signOut: () => void; refresh: () => void };

/** Settings — account, locale/units, GDPR data tools, and credits. Grouped + searchable. */
export function SettingsPanel(props: { settings: LocaleSettings; onApply: (s: LocaleSettings) => void; callsign: string; session: Sess; onSignIn: () => void; onClose: () => void }) {
  const s = props.settings;
  const fmt = useFmt();
  const [gdpr, setGdpr] = useState<string | null>(null);

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
    <Panel title="⚙ Settings" onClose={props.onClose}>
      <label className="srch"><span className="srch-ic">⌕</span>
        <input value={q} placeholder="Search settings…" onChange={(e) => setQ(e.target.value)} aria-label="Search settings" />
      </label>

      {match("Account callsign callsigns identity verify SSID licence sign in passkey email") && (
        <AccountSettings session={props.session} onSignIn={props.onSignIn} />
      )}

      {match("Display appearance theme units measurement") && (
        <Group title="Display">
          <Row label="Theme">
            <div className="seg">{(["dark", "light", "auto"] as const).map((t) => (
              <button key={t} className={s.theme === t ? "on" : ""} onClick={() => props.onApply({ ...s, theme: t })}>{t}</button>
            ))}</div>
          </Row>
          <Row label="Units" help="distances, speed, temperature">
            <div className="seg">{(["metric", "imperial"] as const).map((u) => (
              <button key={u} className={s.units === u ? "on" : ""} onClick={() => props.onApply({ ...s, units: u })}>{u}</button>
            ))}</div>
          </Row>
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

      {match("About credits attribution Bruninga WB4APR APRS trademark licence open source") && (
        <Group title="About & credits" defaultOpen={false}>
          <p className="muted">APRScaching is a caching-first web workbench by <span className="mono">OE8APR</span>.</p>
          <p className="muted">APRS — the Automatic Packet Reporting System — was created by the late
            {" "}<strong>Bob Bruninga, WB4APR</strong> (1948–2022). “APRS” is his trademark. This is an
            independent, unofficial implementation built from open specifications (APRS101, APRS-IS) and
            is not affiliated with, sponsored by, or endorsed by him or his estate.</p>
          <p className="muted">Maps © OpenStreetMap contributors, rendered with MapLibre. Built on open
            source; the APRScaching game and this app are the author’s own work.</p>
        </Group>
      )}
    </Panel>
  );
}
