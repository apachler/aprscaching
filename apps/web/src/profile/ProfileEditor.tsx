// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import { getProfile, updateProfile, type ProfileEdit } from "../api.js";
import { Row, Switch, useToast } from "../ui/index.js";

/** Settings → Profile: edit the thin, opt-in ham profile (docs/design/13). Sanitised + validated server-side. */
export function ProfileEditor(props: { callsign: string }) {
  const toast = useToast();
  const [p, setP] = useState<ProfileEdit>({ profilePublic: true, links: [] });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (props.callsign.length < 3) return;
    getProfile(props.callsign).then((r) => {
      const c = r.profile ?? {};
      setP({ displayName: c.displayName ?? "", homeGrid: c.homeGrid ?? "", avatarUrl: c.avatarUrl ?? "", bio: c.bio ?? "", publicContact: c.publicContact ?? "", links: c.links ?? [], profilePublic: true });
    }).catch(() => {});
  }, [props.callsign]);

  const setLink = (i: number, k: "label" | "url", v: string) => setP((s) => ({ ...s, links: (s.links ?? []).map((l, j) => (j === i ? { ...l, [k]: v } : l)) }));
  const addLink = () => setP((s) => ({ ...s, links: [...(s.links ?? []), { label: "", url: "" }].slice(0, 5) }));
  const removeLink = (i: number) => setP((s) => ({ ...s, links: (s.links ?? []).filter((_, j) => j !== i) }));

  async function save() {
    setBusy(true);
    try { await updateProfile({ ...p, links: (p.links ?? []).filter((l) => l.url.trim()) }); toast("Profile saved"); }
    catch (e) { toast((e as Error).message); }
    finally { setBusy(false); }
  }

  if (props.callsign.length < 3) return <p className="muted">Sign in to set up your profile.</p>;
  return (
    <>
      <p className="muted">A self-curated card on your public profile. Everything is opt-in; leave a field blank to hide it.</p>
      <Row label="Show my profile publicly">
        <Switch label="Show my profile publicly" checked={p.profilePublic !== false} onChange={(v) => setP((s) => ({ ...s, profilePublic: v }))} />
      </Row>
      <label>Display name <input value={p.displayName ?? ""} maxLength={60} placeholder={props.callsign} onChange={(e) => setP((s) => ({ ...s, displayName: e.target.value }))} /></label>
      <label>Locator (Maidenhead) <input className="mono" value={p.homeGrid ?? ""} maxLength={10} placeholder="JN77bc12de" onChange={(e) => setP((s) => ({ ...s, homeGrid: e.target.value }))} /></label>
      <label>Avatar URL <input value={p.avatarUrl ?? ""} placeholder="https://…/me.png" onChange={(e) => setP((s) => ({ ...s, avatarUrl: e.target.value }))} /></label>
      <label>Bio <textarea value={p.bio ?? ""} rows={3} maxLength={500} placeholder="A line or two about your station / operating." onChange={(e) => setP((s) => ({ ...s, bio: e.target.value }))} /></label>
      <label>Public contact email <span className="muted">(optional; your sign-in email stays private)</span>
        <input value={p.publicContact ?? ""} placeholder="you@example.com" onChange={(e) => setP((s) => ({ ...s, publicContact: e.target.value }))} /></label>

      <h4>Links</h4>
      {(p.links ?? []).map((l, i) => (
        <div className="row gap-2" key={i}>
          <input className="field-sm" value={l.label} placeholder="label" maxLength={40} onChange={(e) => setLink(i, "label", e.target.value)} />
          <input value={l.url} placeholder="https://…" onChange={(e) => setLink(i, "url", e.target.value)} />
          <button className="icon" aria-label="Remove link" onClick={() => removeLink(i)}>✕</button>
        </div>
      ))}
      {(p.links ?? []).length < 5 && <button className="link" onClick={addLink}>+ add link</button>}

      <div className="row end mt-5"><button className="primary" onClick={save} disabled={busy}>Save profile</button></div>
    </>
  );
}
