import { useState } from "react";
import { startAprsVerify, confirmAprsVerify, changeCallsign } from "../api.js";
import { Group, Badge, Icon, Advanced } from "../ui/index.js";

type Session = { callsign: string; verified: boolean; email: string | null; signedIn: boolean; signOut: () => void; refresh: () => void };
const baseCall = (c: string) => c.toUpperCase().split("-")[0] ?? "";

/** Settings → Account: the signed-in identity, callsign-control verification, and sign-out.
 *  (Changing the callsign is the S5 flow; held off here.) */
export function AccountSettings(props: { session: Session; onSignIn: () => void }) {
  const { callsign, verified, email, signedIn, signOut, refresh } = props.session;
  const [verifying, setVerifying] = useState(false);
  const [code, setCode] = useState("");
  const [newCs, setNewCs] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function doChange() {
    const n = newCs.toUpperCase().trim();
    if (n.length < 3) { setMsg("Enter the new callsign."); return; }
    setBusy(true); setMsg(null);
    try { await changeCallsign(n); setNewCs(""); setMsg(`Now operating as ${n} — re-verify to re-enable announce.`); refresh(); }
    catch (e) { setMsg((e as Error).message.replace(/^.*?: /, "")); } finally { setBusy(false); }
  }

  async function startVerify() {
    setBusy(true); setMsg(null);
    try { await startAprsVerify(baseCall(callsign)); setVerifying(true); setCode(""); setMsg(`Sent a code to ${baseCall(callsign)} over APRS — read it on your radio and enter it.`); }
    catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }
  async function confirm() {
    setBusy(true); setMsg(null);
    try {
      const r = await confirmAprsVerify(baseCall(callsign), code.trim());
      if (r.verified) { setVerifying(false); setMsg(`${baseCall(callsign)} verified ✓`); refresh(); }
      else setMsg("That code didn't match. Check your radio and try again.");
    } catch { setMsg("That code didn't match. Check your radio and try again."); }
    finally { setBusy(false); }
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
    <Group title="Account" status={callsign}>
      <div className="setrow">
        <div className="setrow-l"><div>Callsign</div><div className="muted setrow-help">your operating callsign (base + SSID)</div></div>
        <div className="setrow-c">
          <span className="mono">{callsign}</span>
          {verified
            ? <Badge kind="tierA" title="callsign-control verified"><Icon name="check" size={12} /> verified</Badge>
            : <button className="link" disabled={busy} onClick={startVerify}>verify</button>}
        </div>
      </div>
      {verifying && (
        <div className="verify-code">
          <label className="m-0">Code sent to <span className="mono">{baseCall(callsign)}</span>
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" placeholder="123456" maxLength={6} />
          </label>
          <div className="row end mt-2"><button onClick={() => setVerifying(false)}>Cancel</button>
            <button className="primary" disabled={busy || code.trim().length < 4} onClick={confirm}>{busy ? "Checking…" : "Confirm"}</button></div>
        </div>
      )}
      {email && <div className="setrow"><div className="setrow-l"><div>Email</div></div><div className="setrow-c muted">{email}</div></div>}
      <Advanced label="Change callsign">
        <p className="muted fine">Switch the call you operate under (one active at a time). The new call starts unverified — re-verify it above. Past finds stay attributed to the call they were logged with.</p>
        <div className="row">
          <input value={newCs} placeholder="OE1XYZ" onChange={(e) => setNewCs(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") doChange(); }} />
          <button className="primary" disabled={busy} onClick={doChange}>Change</button>
        </div>
      </Advanced>
      <div className="row end mt-3"><button className="danger" onClick={signOut}>Sign out</button></div>
      {msg && <p className="muted mt-2">{msg}</p>}
      <p className="muted fine mt-2">Verification proves you hold the licensed base call; its SSID stations (-7 HT, -9 mobile, -10 IGate…) inherit it.</p>
    </Group>
  );
}
