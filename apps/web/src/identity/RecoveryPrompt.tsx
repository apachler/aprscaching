// SPDX-License-Identifier: AGPL-3.0-or-later
import { useId, useState } from "react";
import { changeEmail, errorText, registerPasskey, resendEmailConfirmation } from "../api.js";
import { Button, useToast } from "../ui/index.js";
import { passkeyErrorText, passkeyProblem, PASSKEY_PROBLEM_TEXT } from "./passkeySupport.js";

/**
 * The step an account with no passkey and no confirmed email is asked to take: add one of them, or it cannot
 * sign in again once this session ends. A callsign taken over by proof of control opens such an account, and so
 * can an operator's link. The app shows it as a bar over the map (`bar`, with Later) and as a lasting warning in
 * Settings → Account (`inline`), until the account has a passkey or a confirmed email.
 */
export function RecoveryPrompt(props: {
  callsign: string;
  /** An address waiting for its owner to open the confirmation link. */
  pendingEmail: string | null;
  variant: "bar" | "inline";
  /** The account changed (a passkey added, an address given): read the session again. */
  onChanged: (what: "passkey" | "email") => void;
  /** Hide the bar until the app starts again. */
  onLater?: () => void;
}) {
  const toast = useToast();
  const titleId = useId();
  const [emailOpen, setEmailOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean; devLink?: string } | null>(null);
  const noPasskey = passkeyProblem();

  async function addPasskey() {
    setBusy(true);
    setMsg(null);
    try {
      await registerPasskey(props.callsign);
      toast("Passkey added: this device signs you in with it");
      props.onChanged("passkey");
    } catch (e) {
      setMsg({ text: passkeyErrorText(e, (x) => errorText(x).replace(/^.*?: /, "")), error: true });
    } finally {
      setBusy(false);
    }
  }

  async function sendEmail(resend: boolean) {
    const e = draft.trim();
    if (!resend && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) {
      setMsg({ text: "Enter a valid email address.", error: true });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = resend ? await resendEmailConfirmation() : await changeEmail(e);
      setMsg(
        r.devLink
          ? { text: "This instance sends no mail.", devLink: r.devLink }
          : { text: `We sent a confirmation link to ${r.pendingEmail ?? e}. Open it to finish.` },
      );
      setEmailOpen(false);
      props.onChanged("email");
    } catch (err) {
      setMsg({ text: errorText(err), error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className={props.variant === "bar" ? "recovery-notice" : "inline-note bad recovery-inline"}
      aria-labelledby={titleId}
    >
      <p className="m-0" id={titleId}>
        <strong>Add a passkey or an email so you can sign in again.</strong>
      </p>
      <p className="m-0 fine">
        {props.pendingEmail ? (
          <>
            Open the link we sent to <span className="mono">{props.pendingEmail}</span> to confirm it. Until then, this
            session is your only way into <span className="mono">{props.callsign}</span>.
          </>
        ) : (
          <>
            This account has no passkey and no confirmed email. Once this session ends, nobody can sign in to{" "}
            <span className="mono">{props.callsign}</span>.
          </>
        )}
      </p>
      {noPasskey && <p className="m-0 fine muted">{PASSKEY_PROBLEM_TEXT[noPasskey]}</p>}
      {emailOpen && (
        <label className="m-0">
          Email
          <input
            type="email"
            autoComplete="email"
            autoFocus
            value={draft}
            placeholder="you@example.com"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void sendEmail(false);
            }}
          />
        </label>
      )}
      <div className="row wrap gap-2 end">
        {props.variant === "bar" && props.onLater && (
          <Button variant="quiet" onClick={props.onLater}>
            Later
          </Button>
        )}
        {emailOpen ? (
          <Button variant="primary" disabled={busy} onClick={() => void sendEmail(false)}>
            Send confirmation
          </Button>
        ) : props.pendingEmail ? (
          <Button disabled={busy} onClick={() => void sendEmail(true)}>
            Resend the link
          </Button>
        ) : (
          <Button disabled={busy} onClick={() => setEmailOpen(true)}>
            Add an email
          </Button>
        )}
        {!noPasskey && !emailOpen && (
          <Button variant="primary" disabled={busy} onClick={() => void addPasskey()}>
            Add a passkey
          </Button>
        )}
      </div>
      {msg && (
        <p className={`m-0 fine ${msg.error ? "error" : ""}`} role={msg.error ? "alert" : "status"}>
          {msg.text}
          {msg.devLink && (
            <>
              {" "}
              <a href={msg.devLink}>Open the confirmation link</a>
            </>
          )}
        </p>
      )}
    </section>
  );
}
