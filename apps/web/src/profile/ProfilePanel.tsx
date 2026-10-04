// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useState } from "react";
import { badgeUrl, getProfile, getLicence, exportPath, type Licence, type Profile } from "../api.js";
import { ExportButton } from "../exports/ExportButton.js";
import { useFmt } from "../format.js";
import {
  Button,
  Panel,
  Group,
  Badge,
  CallVerifiedBadge,
  CommandBlock,
  LicenceBadge,
  ErrorState,
  EmptyState,
  Icon,
  InfoTip,
  Hint,
} from "../ui/index.js";
import { badgeInfo } from "./badges.js";
import { RadioLogs } from "./RadioLogs.js";
import { usePlatform } from "../platform/PlatformContext.js";
import { TERMS } from "../terms.js";

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
              <CallVerifiedBadge />
            ) : (
              <>
                <Badge title="Your finds count on the leaderboard, and transmit opens, once your callsign is verified">
                  unverified
                </Badge>{" "}
                <Button variant="quiet" hint="Open Settings to prove you hold this callsign" onClick={props.onSettings}>
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
          {!verified && (
            <p className="muted fine">
              Your finds don&apos;t count on the leaderboard until your callsign is verified.
            </p>
          )}
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
          {profile && (
            <div className="row between">
              <span className="muted">Your finds as ADIF, for your logbook program.</span>
              <ExportButton
                label="Download ADIF"
                filename={`${callsign.toUpperCase().split("-")[0]}-finds.adif`}
                path={() => exportPath.findsAdif(callsign)}
              />
            </div>
          )}
          {profile && (profile.corroborations ?? 0) > 0 && (
            <p>
              <Badge kind="tierA" title="Finds your receiving stations heard on the air and made Radio-verified">
                ⇅ Infrastructure
              </Badge>{" "}
              <strong>{profile.corroborations}</strong> finds corroborated{" "}
              <InfoTip text={TERMS.corroboration} label="What is corroboration?" />
            </p>
          )}
          {profile && profile.badges.length > 0 && (
            <div className="badges">
              {profile.badges.map((b) => {
                const info = badgeInfo(b.badge);
                const award = <span className="award">{info.name}</span>;
                return info.how ? (
                  <Hint key={b.badge} text={info.how}>
                    {award}
                  </Hint>
                ) : (
                  <span key={b.badge} className="award">
                    {info.name}
                  </span>
                );
              })}
            </div>
          )}
          {profile && profile.badges.length === 0 && (
            <EmptyState>No badges yet: your first verified find and your first hide each earn one.</EmptyState>
          )}
        </>
      )}

      {callsign.length >= 3 && <RadioLogs />}

      {callsign.length >= 3 && <EmbedBadge callsign={callsign.toUpperCase().split("-")[0]!} />}

      <Group title="Advanced — the Shack" defaultOpen={false}>
        <p className="muted">Live stations, transports, digipeater, IGate, BBS, decoder. A cacher never needs this.</p>
        <div className="row wrap">
          <Button onClick={props.onShack} hint="Open the radio apps launcher">
            <Icon name="antenna" cp437="" className="lead-ic" />
            Shack
          </Button>
          <Button onClick={props.onMail} hint="Read and write packet-radio mail and bulletins">
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

/** Your badge for QRZ.com, a forum signature or a club page: the live image and the HTML that shows it. */
function EmbedBadge(props: { callsign: string }) {
  const src = badgeUrl(props.callsign);
  const alt = `${props.callsign} on APRScaching`;
  const html = `<a href="${location.origin}"><img src="${src}" alt="${alt}" width="360" height="96"></a>`;
  return (
    <Group title="Embed your badge" defaultOpen={false}>
      <p className="muted">
        Your rank, verified finds, points and hides, kept current. Paste the HTML on QRZ.com, a forum signature or a
        club page.
      </p>
      <img className="badge-embed" src={src} alt={alt} width={360} height={96} />
      <CommandBlock label="HTML for your badge" command={html} copied="HTML copied" />
    </Group>
  );
}
