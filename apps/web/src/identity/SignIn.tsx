// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { claim, registerPasskey, loginPasskey, emailStart, errorText, ApiError, type Licence } from "../api.js";
import { Button, Panel, Icon, LicenceBadge, ManualLink } from "../ui/index.js";
import { PASSKEY_PROBLEM_TEXT, passkeyErrorText, passkeyProblem } from "./passkeySupport.js";

type Probe = { exists: boolean; hasPasskey: boolean; licence?: Licence } | null;

/** Sign in / create account: passkey first, email magic-link fallback. Callsign-led. */
export function SignIn(props: {
  onDone: () => void;
  onClose: () => void;
  /** Leave sign-in for the map, for someone without a licence; closing returns to the map where no other way is given. */
  onBrowse?: () => void;
}) {
  const [cs, setCs] = useState("");
  const [email, setEmail] = useState("");
  const [probe, setProbe] = useState<Probe>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState<{ text: string; devLink?: string } | null>(null);
  const callsign = cs.toUpperCase().trim();
  const noPasskey = passkeyProblem();
  const canPasskey = noPasskey === null;

  async function check() {
    if (callsign.length < 3) {
      setErr("Enter your callsign.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      setProbe(await claim(callsign));
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      props.onDone();
    } catch (e) {
      setErr(passkeyErrorText(e, (x) => errorText(x).replace(/^.*?: /, "")));
    } finally {
      setBusy(false);
    }
  }
  async function sendEmail() {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setErr("Enter a valid email.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await emailStart(email.trim(), callsign);
      setSent(
        r.devLink
          ? { text: "This instance sends no mail.", devLink: r.devLink }
          : { text: `Check ${email} for your sign-in link.` },
      );
    } catch (e) {
      // An email with no account opens a new one for the call, so a held call refuses it: for a returning
      // user that means the email is not the one on their account.
      if (probe?.exists && e instanceof ApiError && e.status === 409)
        setErr(
          `That email doesn't match ${callsign}'s account — use the email you registered with${
            probe.hasPasskey && canPasskey ? ", or sign in with your passkey" : ""
          }.`,
        );
      else setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Sign in" onClose={props.onClose}>
      {sent ? (
        <p className="muted mt-3">
          {sent.text}
          {sent.devLink && (
            <>
              {" "}
              <a href={sent.devLink}>Open the sign-in link</a>
            </>
          )}
        </p>
      ) : !probe ? (
        <>
          <p className="muted">Sign in with your callsign to claim and log your finds.</p>
          <label>
            Callsign
            <input
              autoFocus
              value={cs}
              aria-describedby="signin-call-help"
              placeholder="OE8APR"
              onChange={(e) => setCs(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") check();
              }}
            />
          </label>
          <p className="muted fine" id="signin-call-help">
            Your amateur radio callsign: an account needs the call a licence gave you.
          </p>
          <div className="row end">
            <Button variant="primary" disabled={busy} onClick={check}>
              Continue
            </Button>
          </div>
          <p className="muted fine mt-3">
            No licence yet?{" "}
            <Button variant="inline" onClick={props.onBrowse ?? props.onClose}>
              Browse the map
            </Button>{" "}
            without an account, or{" "}
            <ManualLink page="play/join" anchor="no-licence-yet">
              read how to get one
            </ManualLink>
            .
          </p>
        </>
      ) : (
        <>
          <p className="muted">
            Callsign <span className="mono">{callsign}</span>
            {probe.exists ? "" : " — new account"}.
          </p>
          {!probe.exists && probe.licence && (
            <p className="muted fine">
              <LicenceBadge licence={probe.licence} />
            </p>
          )}

          {probe.hasPasskey && canPasskey && (
            <Button
              variant="primary"
              className="log-primary"
              disabled={busy}
              onClick={() => run(() => loginPasskey(callsign))}
            >
              <Icon name="shield-check" size={18} /> Sign in with passkey
            </Button>
          )}
          {!probe.exists && canPasskey && (
            <Button
              variant="primary"
              className="log-primary"
              disabled={busy}
              onClick={() => run(() => registerPasskey(callsign, email.trim() || undefined))}
            >
              <Icon name="shield-check" size={18} /> Create account with a passkey
            </Button>
          )}
          {!probe.exists && canPasskey && email.trim() !== "" && (
            <p className="muted fine">
              We email a link to confirm this address. It signs you in once you open the link; until then Settings shows
              it as waiting for confirmation.
            </p>
          )}

          <div className="adv-body">
            <p className="muted fine mt-3">
              {probe.exists
                ? canPasskey && probe.hasPasskey
                  ? "Or use the email on your account:"
                  : "Get a sign-in link at the email on your account:"
                : canPasskey
                  ? "Or create it with an email link:"
                  : "Create your account with an email link:"}
            </p>
            <label className="m-0">
              <input
                aria-label="Email"
                type="email"
                autoComplete="email"
                value={email}
                placeholder="you@example.com"
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <div className="row end mt-2">
              <Button disabled={busy} onClick={sendEmail}>
                Email me a link
              </Button>
            </div>
          </div>
          <Button
            variant="quiet"
            className="mt-3"
            onClick={() => {
              setProbe(null);
              setErr(null);
            }}
          >
            ← different callsign
          </Button>
        </>
      )}
      {err && (
        <p className="error mt-2" role="alert">
          {err}
        </p>
      )}
      {noPasskey && !sent && (
        <p className="muted fine mt-3" role="note">
          {PASSKEY_PROBLEM_TEXT[noPasskey]}
        </p>
      )}
    </Panel>
  );
}
