// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useState } from "react";
import { startAprsVerify, confirmAprsVerify, changeCallsign, addCallsign, listCallsigns, type HeldCallsign } from "../api.js";
import { Group, Badge, Icon, Advanced } from "../ui/index.js";

type Session = { callsign: string; verified: boolean; email: string | null; signedIn: boolean; signOut: () => void; refresh: () => void };
const baseCall = (c: string) => c.toUpperCase().split("-")[0] ?? "";

/** Settings → Account: the signed-in identity, the account's held base callsigns (switch / add /
 *  verify each), and sign-out. An account is a person who may hold several licensed base calls;
 *  switching the active call never re-verifies, only adding a new one does. */
export function AccountSettings(props: { session: Session; onSignIn: () => void }) {
  const { callsign, email, signedIn, signOut, refresh } = props.session;
  const active = baseCall(callsign);
  const [held, setHeld] = useState<HeldCallsign[]>([]);
  const [verifyingCall, setVerifyingCall] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [newCs, setNewCs] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!signedIn) return;
    try { setHeld((await listCallsigns()).callsigns); } catch { /* keep prior list */ }
  }, [signedIn]);
  useEffect(() => { void reload(); }, [reload, callsign]);

  async function setActive(cs: string) {
    setBusy(true); setMsg(null);
    try { await changeCallsign(cs); setMsg(`Now operating as ${cs}.`); refresh(); await reload(); }
    catch (e) { setMsg((e as Error).message.replace(/^.*?: /, "")); } finally { setBusy(false); }
  }
  async function startVerify(cs: string) {
    setBusy(true); setMsg(null);
    try { await startAprsVerify(cs); setVerifyingCall(cs); setCode(""); setMsg(`Sent a code to ${cs} over APRS — read it on your radio and enter it.`); }
    catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }
  async function confirm(cs: string) {
    setBusy(true); setMsg(null);
    try {
      const r = await confirmAprsVerify(cs, code.trim());
      if (r.verified) { setVerifyingCall(null); setMsg(`${cs} verified ✓`); if (cs === active) refresh(); await reload(); }
      else setMsg("That code didn't match. Check your radio and try again.");
    } catch { setMsg("That code didn't match. Check your radio and try again."); }
    finally { setBusy(false); }
  }
  async function addNew() {
    const n = baseCall(newCs.trim());
    if (n.length < 3) { setMsg("Enter a callsign to add."); return; }
    setBusy(true); setMsg(null);
    try { await addCallsign(n); setNewCs(""); setMsg(`Added ${n} — verify it below to enable announce + leaderboard credit.`); await reload(); }
    catch (e) { setMsg((e as Error).message.replace(/^.*?: /, "")); } finally { setBusy(false); }
  }

  if (!signedIn) {
    return (
      <Group title="Account" status="signed out">
        <p className="muted">Sign in with your callsign to claim and log your finds.</p>
        <div className="row end"><button className="primary" onClick={props.onSignIn}>Sign in</button></div>
      </Group>
    );
  }
  return (
    <Group title="Account" status={active}>
      <ul className="cs-list">
        {held.map((c) => (
          <li key={c.callsign} className="setrow">
            <div className="setrow-l">
              <span className="mono">{c.callsign}</span>
              {c.active && <Badge kind="found" title="your active operating callsign">active</Badge>}
              {c.isPrimary && <Badge title="the callsign your passkey is bound to">primary</Badge>}
            </div>
            <div className="setrow-c">
              {c.verified
                ? <Badge kind="tierA" title="callsign-control verified"><Icon name="check" size={12} /> verified</Badge>
                : <button className="link" disabled={busy} onClick={() => startVerify(c.callsign)}>verify</button>}
              {!c.active && <button disabled={busy} onClick={() => setActive(c.callsign)}>Set active</button>}
            </div>
          </li>
        ))}
      </ul>
      {verifyingCall && (
        <div className="verify-code">
          <label className="m-0">Code sent to <span className="mono">{verifyingCall}</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" placeholder="123456" maxLength={6} />
          </label>
          <div className="row end mt-2"><button onClick={() => setVerifyingCall(null)}>Cancel</button>
            <button className="primary" disabled={busy || code.trim().length < 4} onClick={() => confirm(verifyingCall)}>{busy ? "Checking…" : "Confirm"}</button></div>
        </div>
      )}
      <Advanced label="Add a callsign">
        <p className="muted fine">Hold another licensed base call on this account (a club call, a second-country call). Each SSID station (-7 HT, -9 mobile, -10 IGate…) inherits its base call's verification.</p>
        <div className="row">
          <input value={newCs} placeholder="OE1XYZ" aria-label="Additional base callsign" onChange={(e) => setNewCs(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addNew(); }} />
          <button className="primary" disabled={busy} onClick={addNew}>Add</button>
        </div>
      </Advanced>
      {email && <div className="setrow"><div className="setrow-l"><div>Email</div></div><div className="setrow-c muted">{email}</div></div>}
      <div className="row end mt-3"><button className="danger" onClick={signOut}>Sign out</button></div>
      {msg && <p className="muted mt-2">{msg}</p>}
      <p className="muted fine mt-2">Switching your active call never re-verifies a call you already hold; only adding a new one does. Past finds stay attributed to the call they were logged with.</p>
    </Group>
  );
}
