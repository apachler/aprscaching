import { useEffect, useState } from "react";
import maplibregl from "maplibre-gl";
import { getProfile, type Profile } from "../api.js";
import { useFmt } from "../format.js";
import { Panel, Group, Badge } from "../ui/index.js";

/** Profile — your identity and the one door to the advanced APRS tools. */
export function ProfilePanel(props: {
  callsign: string; map: maplibregl.Map | null;
  onWorkbench: () => void; onMail: () => void; onSettings: () => void; onSiteMap: () => void; onClose: () => void;
}) {
  const fmt = useFmt();
  const [profile, setProfile] = useState<Profile | null>(null);
  useEffect(() => {
    if (props.callsign.length >= 3) getProfile(props.callsign).then(setProfile).catch(console.error);
    else setProfile(null);
  }, [props.callsign]);
  return (
    <Panel onClose={props.onClose} title={<>👤 <span className="mono">{props.callsign || "Profile"}</span></>}>
      {props.callsign.length < 3 ? <p className="muted">Set your callsign in the top bar to claim your finds.</p> : (<>
        <p><Badge kind="tierC">unverified account</Badge> <button className="link" title="Send an APRS message-challenge to your callsign (coming in the identity pass)">verify callsign</button></p>
        {profile && <p><strong>{profile.finds}</strong> finds · <strong>{profile.points}</strong> pts · <strong>{profile.hides}</strong> hidden
          {profile.lastFind && <span className="muted"> · last find {fmt.date(profile.lastFind)}</span>}</p>}
        {profile && profile.badges.length > 0 && (
          <div className="badges">{profile.badges.map((b) => <span key={b.badge} className="award">{b.badge}</span>)}</div>
        )}
        <Group title="Announce to APRS-IS" status="needs verification"
               master={{ on: false, set: () => {}, disabled: true }}
               reason="Verify your callsign to announce finds on APRS-IS." />
      </>)}

      <Group title="Advanced — APRS workbench" defaultOpen={false}>
        <p className="muted">Live stations, transports, digipeater, IGate, BBS, decoder. A cacher never needs this.</p>
        <div className="row wrap">
          <button onClick={props.onWorkbench}>📡 Workbench</button>
          <button onClick={props.onMail}>✉ BBS</button>
          <button onClick={props.onSettings}>⚙ Settings</button>
          <button onClick={props.onSiteMap}>🗺 Site map</button>
        </div>
      </Group>
    </Panel>
  );
}
