// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useState } from "react";
import { getProfile, getLicence, type Licence, type Profile } from "../api.js";
import { useFmt } from "../format.js";
import { Button, Panel, Group, Badge, CallVerifiedBadge, LicenceBadge, ErrorState, Icon } from "../ui/index.js";
import { badgeInfo } from "./badges.js";
import { RadioLogs } from "./RadioLogs.js";
import { usePlatform } from "../platform/PlatformContext.js";
import { TermHelp } from "../platform/TermHelp.js";

/** Profile — your identity and the one door to the advanced APRS tools. */
export function ProfilePanel(props: {
  onShack: () => void;
  onMail: () => void;
  onSettings: () => void;
  onSignIn: () => void;
  onClose: () => void;
}) {
  const { callsign, verified } = usePlatform();
  const fmt = useFmt();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState(false);
  const [licence, setLicence] = useState<Licence | null>(null);
  const load = useCallback(() => {
    setError(false);
    if (callsign.length >= 3)
      getProfile(callsign)
        .then(setProfile)
        .catch(() => setError(true));
    else setProfile(null);
    setLicence(null);
    // validity from public registers is a side note: a failed lookup simply shows no badge
    if (callsign.length >= 3)
      getLicence(callsign)
        .then(setLicence)
        .catch(() => setLicence(null));
  }, [callsign]);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <Panel
      onClose={props.onClose}
      title={
        <>
          <Icon name="profile" cp437="" className="lead-ic" />
          <span className="mono">{callsign || "Profile"}</span>
        </>
      }
    >
      {callsign.length < 3 ? (
        <>
          <p className="muted">Sign in with your callsign to claim and log your finds.</p>
          <Button variant="primary" onClick={props.onSignIn}>
            Sign in
          </Button>
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
            {verified ? (
              <CallVerifiedBadge label="control-verified" title="You verified control of this callsign" />
            ) : (
              <>
                <Badge title="Verify control of your callsign to enable transmit">unverified</Badge>{" "}
                <Button
                  variant="quiet"
                  title="Verify control of your callsign in Settings → Account"
                  onClick={props.onSettings}
                >
                  Verify callsign
                </Button>
              </>
            )}
            {licence && (
              <>
                {" "}
                <LicenceBadge licence={licence} />
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
            <p title="Finds your receiving stations heard on the air and made Radio-verified">
              <Badge kind="tierA">⇅ Infrastructure</Badge> <strong>{profile.corroborations}</strong> finds corroborated{" "}
              <TermHelp term="corroboration" />
            </p>
          )}
          {profile && profile.badges.length > 0 && (
            <div className="badges">
              {profile.badges.map((b) => {
                const info = badgeInfo(b.badge);
                return (
                  <span key={b.badge} className="award" title={info.how || undefined}>
                    {info.name}
                  </span>
                );
              })}
            </div>
          )}
        </>
      )}

      {callsign.length >= 3 && <RadioLogs />}

      <Group title="Advanced — the Shack" defaultOpen={false}>
        <p className="muted">Live stations, transports, digipeater, IGate, BBS, decoder. A cacher never needs this.</p>
        <div className="row wrap">
          <Button onClick={props.onShack}>
            <Icon name="antenna" cp437="" className="lead-ic" />
            Shack
          </Button>
          <Button onClick={props.onMail}>
            <Icon name="message" cp437="" className="lead-ic" />
            BBS
          </Button>
          <Button onClick={props.onSettings}>
            <Icon name="settings" cp437="" className="lead-ic" />
            Settings
          </Button>
        </div>
      </Group>
    </Panel>
  );
}
