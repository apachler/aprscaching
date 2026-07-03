// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import maplibregl from "maplibre-gl";
import { getProfile, type Profile } from "../api.js";
import { useFmt } from "../format.js";
import { Panel, Group, Badge, Ico } from "../ui/index.js";

/** Profile — your identity and the one door to the advanced APRS tools. */
export function ProfilePanel(props: {
  callsign: string;
  map: maplibregl.Map | null;
  onWorkbench: () => void;
  onMail: () => void;
  onSettings: () => void;
  onClose: () => void;
}) {
  const fmt = useFmt();
  const [profile, setProfile] = useState<Profile | null>(null);
  useEffect(() => {
    if (props.callsign.length >= 3) getProfile(props.callsign).then(setProfile).catch(console.error);
    else setProfile(null);
  }, [props.callsign]);
  return (
    <Panel
      onClose={props.onClose}
      title={
        <>
          <Ico e="👤 " />
          <span className="mono">{props.callsign || "Profile"}</span>
        </>
      }
    >
      {props.callsign.length < 3 ? (
        <p className="muted">Set your callsign in the top bar to claim your finds.</p>
      ) : (
        <>
          {profile?.profile && (
            <div className="profile-card">
              {profile.profile.avatarUrl && <img className="profile-avatar" src={profile.profile.avatarUrl} alt="" />}
              <div className="profile-card-body">
                {profile.profile.displayName && <div className="profile-name">{profile.profile.displayName}</div>}
                {profile.profile.homeGrid && <span className="muted mono">{profile.profile.homeGrid}</span>}
                {profile.profile.bio && <p className="profile-bio">{profile.profile.bio}</p>}
                {profile.profile.links && profile.profile.links.length > 0 && (
                  <div className="profile-links">
                    {profile.profile.links.map((l) => (
                      <a key={l.url} href={l.url} target="_blank" rel="noreferrer noopener nofollow">
                        {l.label}
                      </a>
                    ))}
                  </div>
                )}
                {profile.profile.publicContact && (
                  <a className="link" href={`mailto:${profile.profile.publicContact}`}>
                    {profile.profile.publicContact}
                  </a>
                )}
              </div>
            </div>
          )}
          <p>
            <Badge kind="tierC">unverified account</Badge>{" "}
            <button
              className="link"
              title="Send an APRS message-challenge to your callsign (coming in the identity pass)"
            >
              verify callsign
            </button>
            {profile?.supporter && (
              <>
                {" "}
                <Badge kind="tierA" title="Thank you for supporting the project (recognition only)">
                  ♥ Supporter
                </Badge>
              </>
            )}
          </p>
          {profile && (
            <p>
              <strong>{profile.finds}</strong> finds · <strong>{profile.points}</strong> pts ·{" "}
              <strong>{profile.hides}</strong> hidden
              {profile.lastFind && <span className="muted"> · last find {fmt.date(profile.lastFind)}</span>}
              {profile.homeInstance && (
                <span className="muted">
                  {" "}
                  · homed at <span className="mono">{profile.homeInstance}</span>
                </span>
              )}
            </p>
          )}
          {profile && (profile.corroborations ?? 0) > 0 && (
            <p title="Tier-A finds your IGate(s) helped verify">
              <Badge kind="tierA">⇅ Infrastructure</Badge> <strong>{profile.corroborations}</strong> finds corroborated
            </p>
          )}
          {profile && profile.badges.length > 0 && (
            <div className="badges">
              {profile.badges.map((b) => (
                <span key={b.badge} className="award">
                  {b.badge}
                </span>
              ))}
            </div>
          )}
          <Group
            title="Announce to APRS-IS"
            status="needs verification"
            master={{ on: false, set: () => {}, disabled: true }}
            reason="Verify your callsign to announce finds on APRS-IS."
          />
        </>
      )}

      <Group title="Advanced — APRS workbench" defaultOpen={false}>
        <p className="muted">Live stations, transports, digipeater, IGate, BBS, decoder. A cacher never needs this.</p>
        <div className="row wrap">
          <button onClick={props.onWorkbench}>
            <Ico e="📡 " />
            Workbench
          </button>
          <button onClick={props.onMail}>
            <Ico e="✉ " />
            BBS
          </button>
          <button onClick={props.onSettings}>
            <Ico e="⚙ " />
            Settings
          </button>
        </div>
      </Group>
    </Panel>
  );
}
