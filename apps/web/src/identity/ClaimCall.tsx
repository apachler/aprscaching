// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { startClaim, claimStatus, errorText } from "../api.js";
import { Button, Icon } from "../ui/index.js";
import { VerifyCall } from "./VerifyCall.js";
import { RecoveryPrompt } from "./RecoveryPrompt.js";

type Step = { kind: "intro" } | { kind: "proving"; claim: string } | { kind: "done"; signedIn: boolean };

/**
 * Take over a call by proving control of it: an account holds the call without having proven control (or it
 * is the instance operator's call and nobody holds it yet). Opening a claim hands out a token; any
 * verification method then proves control with it, and the call moves to this person — onto the signed-in
 * account, or onto a new account that the claim signs in.
 */
export function ClaimCall(props: {
  callsign: string;
  /** The person is signed in: the call joins their account. Otherwise success opens a new account. */
  signedIn: boolean;
  /** Nobody holds the call yet: it is the instance operator's, registered only by proof of control. */
  operatorCall?: boolean;
  onDone: () => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "intro" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cs = props.callsign;
  // the way back in the new account was given: a passkey, or an address waiting for confirmation
  const [secured, setSecured] = useState<"passkey" | "email" | null>(null);

  async function open() {
    setBusy(true);
    setErr(null);
    try {
      setStep({ kind: "proving", claim: (await startClaim(cs)).claim });
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function proven(claim: string) {
    try {
      const r = await claimStatus(claim);
      if (r.status === "done") {
        setStep({ kind: "done", signedIn: !!r.signedIn });
        props.onDone();
      } else setErr("The claim did not complete. Start again.");
    } catch (e) {
      setErr(errorText(e));
    }
  }

  return (
    <section className="verify-code" aria-label={`Take over ${cs}`}>
      {step.kind === "intro" && (
        <>
          <p className="m-0">
            {props.operatorCall ? (
              <>
                <span className="mono">{cs}</span> is this instance&apos;s operator callsign. It opens only to the
                licensee who proves control of it, or through the operator&apos;s sign-in link.
              </>
            ) : (
              <>
                An account that has not proven control holds <span className="mono">{cs}</span>. If the licence is
                yours, prove you control it and the callsign moves to{" "}
                {props.signedIn ? "your account" : "a new account"}.
              </>
            )}
          </p>
          <p className="muted fine m-0">
            The account that held it keeps its other callsigns and what it logged; nothing it wrote moves to you.
          </p>
          <div className="row end">
            <Button onClick={props.onClose}>Cancel</Button>
            <Button variant="primary" disabled={busy} aria-busy={busy} onClick={() => void open()}>
              {busy ? "Starting…" : "Prove control"}
            </Button>
          </div>
        </>
      )}
      {step.kind === "proving" && (
        <VerifyCall
          callsign={cs}
          claim={step.claim}
          onVerified={() => void proven(step.claim)}
          onClose={props.onClose}
        />
      )}
      {step.kind === "done" && (
        <>
          <p className="m-0" role="status">
            <Icon name="check" size={12} /> <span className="mono">{cs}</span> is yours now, verified.
          </p>
          {/* a new account opened by the claim has no way back in yet: ask for one before Done */}
          {step.signedIn && !secured && (
            <RecoveryPrompt variant="inline" callsign={cs} pendingEmail={null} onChanged={setSecured} />
          )}
          {secured && (
            <p className="muted fine m-0" role="status">
              {secured === "passkey"
                ? "Passkey added: this device signs you in with it."
                : "Open the link we sent to confirm your email; it then signs you in."}
            </p>
          )}
          <div className="row end">
            <Button variant="primary" onClick={props.onClose}>
              Done
            </Button>
          </div>
        </>
      )}
      {err && (
        <p className="error m-0" role="alert">
          {err}
        </p>
      )}
    </section>
  );
}
