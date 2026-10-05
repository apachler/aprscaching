// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import { getMyProfile, updateProfile, type ProfileEdit } from "../api.js";
import { Button, ErrorState, Row, Switch, useLoad, useToast } from "../ui/index.js";

/**
 * Settings → Profile: edit the thin, opt-in ham profile. Sanitised + validated server-side. The form is
 * seeded from the owner's own read, which carries hidden fields and the show/hide switch; until that read
 * has answered there is nothing to save, so a save never blanks a hidden profile or makes it public.
 */
export function ProfileEditor(props: { callsign: string }) {
  const toast = useToast();
  const signedIn = props.callsign.length >= 3;
  const { data, error, reload } = useLoad(
    () => (signedIn ? getMyProfile() : Promise.resolve(undefined)),
    [signedIn, props.callsign],
  );
  const [p, setP] = useState<ProfileEdit | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data) return;
    const c = data.profile;
    setP({
      displayName: c.displayName ?? "",
      homeGrid: c.homeGrid ?? "",
      avatarUrl: c.avatarUrl ?? "",
      bio: c.bio ?? "",
      publicContact: c.publicContact ?? "",
      links: c.links ?? [],
      profilePublic: c.profilePublic,
    });
  }, [data]);

  /** Edit the loaded form; nothing to edit before it has loaded. */
  const edit = (f: (s: ProfileEdit) => ProfileEdit) => setP((s) => (s ? f(s) : s));
  const setLink = (i: number, k: "label" | "url", v: string) =>
    edit((s) => ({ ...s, links: (s.links ?? []).map((l, j) => (j === i ? { ...l, [k]: v } : l)) }));
  const addLink = () => edit((s) => ({ ...s, links: [...(s.links ?? []), { label: "", url: "" }].slice(0, 5) }));
  const removeLink = (i: number) => edit((s) => ({ ...s, links: (s.links ?? []).filter((_, j) => j !== i) }));

  async function save() {
    if (!p) return;
    setBusy(true);
    try {
      await updateProfile({ ...p, links: (p.links ?? []).filter((l) => l.url.trim()) });
      toast("Profile saved");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!signedIn) return <p className="muted">Sign in to set up your profile.</p>;
  if (!p)
    return error ? (
      <ErrorState onRetry={reload}>Couldn&apos;t load your profile, so it can&apos;t be edited yet.</ErrorState>
    ) : (
      <p className="muted" aria-busy="true">
        Loading your profile…
      </p>
    );
  return (
    <>
      <p className="muted">
        A self-curated card on your public profile. Everything is opt-in; leave a field blank to hide it.
      </p>
      <Row
        label="Show my profile publicly"
        help="Off until you turn it on. Your callsign, finds and badges show on the leaderboards either way."
      >
        <Switch
          label="Show my profile publicly"
          checked={p.profilePublic === true}
          onChange={(v) => edit((s) => ({ ...s, profilePublic: v }))}
        />
      </Row>
      {p.profilePublic !== true ? (
        // the switch gates the card: while it is off the fields are folded away, and what they hold stays saved
        <p className="muted" role="status">
          Your profile card is hidden. Turn it on to fill in what other players see.
        </p>
      ) : (
        <>
          <label>
            Display name{" "}
            <input
              value={p.displayName ?? ""}
              maxLength={60}
              placeholder={props.callsign}
              onChange={(e) => edit((s) => ({ ...s, displayName: e.target.value }))}
            />
          </label>
          <label>
            Locator (Maidenhead){" "}
            <input
              className="mono"
              value={p.homeGrid ?? ""}
              maxLength={10}
              placeholder="JN77bc12de"
              onChange={(e) => edit((s) => ({ ...s, homeGrid: e.target.value }))}
            />
          </label>
          <label>
            Avatar URL{" "}
            <input
              value={p.avatarUrl ?? ""}
              placeholder="https://…/me.png"
              onChange={(e) => edit((s) => ({ ...s, avatarUrl: e.target.value }))}
            />
          </label>
          <label>
            Bio{" "}
            <textarea
              value={p.bio ?? ""}
              rows={3}
              maxLength={500}
              placeholder="A line or two about your station / operating."
              onChange={(e) => edit((s) => ({ ...s, bio: e.target.value }))}
            />
          </label>
          <label>
            Public contact email <span className="muted">(optional; your sign-in email stays private)</span>
            <input
              value={p.publicContact ?? ""}
              placeholder="you@example.com"
              onChange={(e) => edit((s) => ({ ...s, publicContact: e.target.value }))}
            />
          </label>

          <h4>Links</h4>
          {(p.links ?? []).map((l, i) => (
            <div className="row gap-2" key={i}>
              <input
                className="field-sm"
                value={l.label}
                placeholder="label"
                aria-label={`Link ${i + 1} label`}
                maxLength={40}
                onChange={(e) => setLink(i, "label", e.target.value)}
              />
              <input
                value={l.url}
                placeholder="https://…"
                aria-label={`Link ${i + 1} URL`}
                onChange={(e) => setLink(i, "url", e.target.value)}
              />
              <Button variant="icon" aria-label={`Remove link ${i + 1}`} onClick={() => removeLink(i)}>
                ✕
              </Button>
            </div>
          ))}
          {(p.links ?? []).length < 5 && (
            <Button variant="quiet" onClick={addLink}>
              + add link
            </Button>
          )}
        </>
      )}

      <div className="row end mt-6">
        <Button variant="primary" onClick={save} disabled={busy}>
          Save profile
        </Button>
      </div>
    </>
  );
}
