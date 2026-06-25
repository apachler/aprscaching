import { useState } from "react";
import { claim, registerPasskey, loginPasskey, emailStart, passkeySupported } from "../api.js";
import { Panel, Icon } from "../ui/index.js";

type Probe = { exists: boolean; hasPasskey: boolean } | null;

/** Sign in / create account (M9): passkey first, email magic-link fallback. Callsign-led. */
export function SignIn(props: { onDone: () => void; onClose: () => void }) {
  const [cs, setCs] = useState("");
  const [email, setEmail] = useState("");
  const [probe, setProbe] = useState<Probe>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const callsign = cs.toUpperCase().trim();
  const canPasskey = passkeySupported();

  async function check() {
    if (callsign.length < 3) { setErr("Enter your callsign."); return; }
    setBusy(true); setErr(null);
    try { setProbe(await claim(callsign)); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setErr(null);
    try { await fn(); props.onDone(); }
    catch (e) { setErr((e as Error).message.replace(/^.*?: /, "")); } finally { setBusy(false); }
  }
  async function sendEmail() {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { setErr("Enter a valid email."); return; }
    setBusy(true); setErr(null);
    try {
      const r = await emailStart(email.trim(), callsign);
      setSent(r.devLink ? `Dev: open ${r.devLink}` : `Check ${email} for your sign-in link.`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Panel title="Sign in" onClose={props.onClose}>
      {sent ? (
        <p className="muted mt-3">{sent}</p>
      ) : !probe ? (<>
        <p className="muted">Sign in with your callsign to claim and log your finds.</p>
        <label>Callsign
          <input autoFocus value={cs} placeholder="OE8APR" onChange={(e) => setCs(e.target.value)}
                 onKeyDown={(e) => { if (e.key === "Enter") check(); }} />
        </label>
        <div className="row end"><button className="primary" disabled={busy} onClick={check}>Continue</button></div>
      </>) : (<>
        <p className="muted">Callsign <span className="mono">{callsign}</span>{probe.exists ? "" : " — new account"}.</p>

        {probe.hasPasskey && canPasskey && (
          <button className="primary log-primary" disabled={busy} onClick={() => run(() => loginPasskey(callsign))}>
            <Icon name="shield-check" size={18} /> Sign in with passkey
          </button>
        )}
        {!probe.exists && canPasskey && (
          <button className="primary log-primary" disabled={busy} onClick={() => run(() => registerPasskey(callsign, email.trim() || undefined))}>
            <Icon name="shield-check" size={18} /> Create account with a passkey
          </button>
        )}

        <div className="adv-body">
          <p className="muted fine mt-3">{canPasskey ? "Or use an email link" : "Sign in with an email link"} {probe.exists ? "" : "(optional, for recovery)"}:</p>
          <label className="m-0"><input value={email} placeholder="you@example.com" onChange={(e) => setEmail(e.target.value)} /></label>
          <div className="row end mt-2"><button disabled={busy} onClick={sendEmail}>Email me a link</button></div>
        </div>
        <button className="link mt-3" onClick={() => { setProbe(null); setErr(null); }}>← different callsign</button>
      </>)}
      {err && <p className="error mt-2">{err}</p>}
      {!canPasskey && !probe && <p className="muted fine mt-3">Passkeys need a secure (https) context; email sign-in works anywhere.</p>}
    </Panel>
  );
}
