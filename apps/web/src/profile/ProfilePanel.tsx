// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useState } from "react";
import type * as maplibregl from "maplibre-gl";
import { getProfile, type Profile } from "../api.js";
import { useFmt } from "../format.js";
import { Panel, Group, Badge, ErrorState, Ico } from "../ui/index.js";

/** Profile — your identity and the one door to the advanced APRS tools. */
export function ProfilePanel(props: {
  callsign: string;
  verified: boolean;
  map: maplibregl.Map | null;
  onShack: () => void;
  onMail: () => void;
  onSettings: () => void;
  onSignIn: () => void;
  onClose: () => void;
}) {
  const fmt = useFmt();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(() => {
    setError(false);
    if (props.callsign.length >= 3)
      getProfile(props.callsign)
        .then(setProfile)
        .catch(() => setError(true));
    else setProfile(null);
  }, [props.callsign]);
  useEffect(() => {
    load();
  }, [load]);
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
        <>
          <p className="muted">Sign in with your callsign to claim and log your finds.</p>
          <button className="primary" onClick={props.onSignIn}>
            Sign in
          </button>
        </>
      ) : error ? (
        <ErrorState onRetry={load}>Couldn't load your profile — check your connection and retry.</ErrorState>
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
            {props.verified ? (
              <Badge kind="found" title="You verified control of this callsign over the air">
                ✓ control-verified
              </Badge>
            ) : (
              <>
                <Badge title="Verify control of your callsign to enable transmit">unverified</Badge>{" "}
                <button
                  className="link"
                  title="Verify control of your callsign in Settings → Account"
                  onClick={props.onSettings}
                >
                  Verify callsign
                </button>
              </>
            )}
            {profile?.supporter && (
              <>
                {" "}
                <Badge title="Thank you for supporting the project (recognition only)">♥ Supporter</Badge>
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
        </>
      )}

      <Group title="Advanced — the Shack" defaultOpen={false}>
        <p className="muted">Live stations, transports, digipeater, IGate, BBS, decoder. A cacher never needs this.</p>
        <div className="row wrap">
          <button onClick={props.onShack}>
            <Ico e="📡 " />
            Shack
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
