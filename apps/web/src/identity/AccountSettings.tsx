// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useState } from "react";
import {
  API_BASE,
  trimTrailingSlashes,
  changeCallsign,
  addCallsign,
  listCallsigns,
  changeEmail,
  resendEmailConfirmation,
  errorText,
  type EmailConfirmation,
  type HeldCallsign,
} from "../api.js";
import {
  Button,
  Group,
  Badge,
  CallVerifiedBadge,
  LicenceBadge,
  licenceLabel,
  Advanced,
  CommandBlock,
  useConfirm,
  useToast,
  useLoad,
} from "../ui/index.js";
import { VerifyCall } from "./VerifyCall.js";
import { Passkeys } from "./Passkeys.js";

type Session = {
  callsign: string;
  verified: boolean;
  email: string | null;
  /** An address waiting for its owner to open the confirmation link: shown, never a way in. */
  pendingEmail?: string | null;
  signedIn: boolean;
  signOut: () => void;
  signOutEverywhere: () => Promise<void>;
  refresh: () => void;
};
const baseCall = (c: string) => c.toUpperCase().split("-")[0] ?? "";

/** Settings → Account: the signed-in identity, the account's held base callsigns (switch / add /
 *  verify each), and sign-out. An account is a person who may hold several licensed base calls;
 *  switching the active call never re-verifies, only adding a new one does. */
export function AccountSettings(props: {
  session: Session;
  onSignIn: () => void;
  /** The account holds this instance's ADMIN_CALLSIGNS call but has not confirmed it yet. */
  operatorPending?: boolean;
}) {
  const { callsign, email, pendingEmail, signedIn, signOut, signOutEverywhere, refresh } = props.session;
  const confirmDialog = useConfirm();
  const toast = useToast();
  const active = baseCall(callsign);
  // the calls this account holds; a failed reload keeps the last list
  const { data: heldList, reload } = useLoad<HeldCallsign[] | undefined>(
    () => (signedIn ? listCallsigns().then((r) => r.callsigns) : Promise.resolve(undefined)),
    [signedIn, callsign],
  );
  const held = heldList ?? [];
  const [verifying, setVerifying] = useState<string | null>(null);
  const [newCs, setNewCs] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "error" } | null>(null);

  async function setActive(cs: string) {
    setBusy(true);
    setMsg(null);
    try {
      await changeCallsign(cs);
      setMsg({ text: `Now operating as ${cs}.`, kind: "ok" });
      refresh();
      reload();
    } catch (e) {
      setMsg({ text: (e as Error).message.replace(/^.*?: /, ""), kind: "error" });
    } finally {
      setBusy(false);
    }
  }
  const onVerified = useCallback(() => {
    if (verifying === active) refresh();
    reload();
  }, [verifying, active, refresh, reload]);

  async function addNew() {
    const n = baseCall(newCs.trim());
    if (n.length < 3) {
      setMsg({ text: "Enter a callsign to add.", kind: "error" });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const added = await addCallsign(n);
      setNewCs("");
      const reg = added.licence ? ` Public registers: ${licenceLabel(added.licence)}.` : "";
      setMsg({ text: `Added ${n} — verify it below to enable announce + leaderboard credit.${reg}`, kind: "ok" });
      reload();
    } catch (e) {
      setMsg({ text: (e as Error).message.replace(/^.*?: /, ""), kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function endEverywhere() {
    const ok = await confirmDialog({
      title: "Sign out everywhere?",
      message: "Every device signed in to this account is signed out, this one included.",
      confirmLabel: "Sign out everywhere",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await signOutEverywhere();
      toast("Signed out on every device");
    } catch (e) {
      setMsg({ text: (e as Error).message, kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  if (!signedIn) {
    return (
      <Group title="Account" status="signed out">
        <p className="muted">Sign in with your callsign to claim and log your finds.</p>
        <div className="row end">
          <Button variant="primary" onClick={props.onSignIn}>
            Sign in
          </Button>
        </div>
      </Group>
    );
  }
  return (
    <Group title="Account" status={active}>
      {props.operatorPending && <OperatorVerify callsign={active} onDone={refresh} />}
      <ul className="cs-list">
        {held.map((c) => (
          <li key={c.callsign} className="setrow">
            <div className="setrow-l">
              <span className="mono">{c.callsign}</span>
              {c.active && (
                <Badge kind="found" title="your active operating callsign">
                  active
                </Badge>
              )}
              {c.isPrimary && <Badge title="the first callsign of your account">primary</Badge>}
              <LicenceBadge licence={c.licence} />
            </div>
            <div className="setrow-c">
              {c.verified ? (
                <CallVerifiedBadge />
              ) : (
                <Button
                  variant="quiet"
                  disabled={busy || verifying === c.callsign}
                  aria-expanded={verifying === c.callsign}
                  onClick={() => setVerifying(c.callsign)}
                >
                  verify
                </Button>
              )}
              {!c.active && (
                <Button disabled={busy} onClick={() => setActive(c.callsign)}>
                  Set active
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {verifying && (
        <VerifyCall key={verifying} callsign={verifying} onVerified={onVerified} onClose={() => setVerifying(null)} />
      )}
      <Advanced label="Add a callsign">
        <p className="muted fine">
          Hold another licensed base call on this account (a club call, a second-country call). Each SSID station (-7
          HT, -9 mobile, -10 IGate…) inherits its base call's verification.
        </p>
        <div className="row">
          <input
            value={newCs}
            placeholder="OE1XYZ"
            aria-label="Additional base callsign"
            onChange={(e) => setNewCs(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addNew();
            }}
          />
          <Button variant="primary" disabled={busy} onClick={addNew}>
            Add
          </Button>
        </div>
      </Advanced>
      <EmailSettings email={email} pendingEmail={pendingEmail ?? null} onChanged={refresh} />
      <Passkeys />
      <div className="row end wrap gap-2 mt-3">
        <Button onClick={endEverywhere} disabled={busy}>
          Sign out everywhere
        </Button>
        <Button variant="danger" onClick={signOut}>
          Sign out
        </Button>
      </div>
      {msg && <p className={`mt-2 ${msg.kind === "error" ? "error" : "muted"}`}>{msg.text}</p>}
      <p className="muted fine mt-2">
        Switching your active call never re-verifies a call you already hold; only adding a new one does. Past finds
        stay attributed to the call they were logged with.
      </p>
      <p className="muted fine">
        The register badge shows whether a public licence register lists the call: the licence exists, not who uses it.
        Only <strong>you control this call</strong> shows that the call is yours.
      </p>
    </Group>
  );
}

/**
 * The account's sign-in and recovery email: the confirmed address, one waiting for confirmation (with a way
 * to mail its link again), and a form to add a first address or change it. A new address waits for its
 * owner to open the link; the confirmed one keeps working until then.
 */
function EmailSettings(props: { email: string | null; pendingEmail: string | null; onChanged: () => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "error"; devLink?: string } | null>(null);

  /** Say how the confirmation mail went: sent, shown here on an instance without mail, or not sent. */
  function report(r: EmailConfirmation) {
    if (!r.pendingEmail) {
      setMsg({ text: `${r.email ?? "Your address"} stays your email.`, kind: "ok" });
      return;
    }
    if (r.devLink) setMsg({ text: "This instance sends no mail.", kind: "ok", devLink: r.devLink });
    else setMsg({ text: `We sent a confirmation link to ${r.pendingEmail}.`, kind: "ok" });
    toast("Confirmation link sent");
  }

  async function submit() {
    const e = draft.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) {
      setMsg({ text: "Enter a valid email address.", kind: "error" });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      report(await changeEmail(e));
      setDraft("");
      setEditing(false);
      props.onChanged();
    } catch (err) {
      setMsg({ text: errorText(err), kind: "error" });
      // a refused mail still leaves the address waiting; show it
      props.onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setBusy(true);
    setMsg(null);
    try {
      report(await resendEmailConfirmation());
    } catch (err) {
      setMsg({ text: errorText(err), kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      <div className="setrow">
        <div className="setrow-l">
          <div>Email</div>
          <div className="muted fine">
            {props.email
              ? "Signs you in with a one-time link and recovers the account."
              : "Add one to sign in with a one-time link and to recover the account."}
          </div>
        </div>
        <div className="setrow-c">
          {props.email ? <span className="muted">{props.email}</span> : <span className="muted">No email</span>}
          <Button
            variant="quiet"
            disabled={busy}
            aria-expanded={editing}
            onClick={() => {
              setEditing((v) => !v);
              setMsg(null);
            }}
          >
            {props.email || props.pendingEmail ? "Change" : "Add email"}
          </Button>
        </div>
      </div>
      {props.pendingEmail && props.pendingEmail !== props.email && (
        <div className="setrow">
          <div className="setrow-l">
            <div className="mono">{props.pendingEmail}</div>
            <div className="muted fine">Open the link we sent to confirm it. Until then it does not sign you in.</div>
          </div>
          <div className="setrow-c">
            <Badge kind="warn">waiting for confirmation</Badge>
            <Button variant="quiet" disabled={busy} onClick={resend}>
              Resend
            </Button>
          </div>
        </div>
      )}
      {editing && (
        <div className="row">
          <input
            type="email"
            autoComplete="email"
            value={draft}
            placeholder="you@example.com"
            aria-label={props.email ? "New email address" : "Email address"}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
          />
          <Button variant="primary" disabled={busy} onClick={submit}>
            Send confirmation
          </Button>
        </div>
      )}
      {msg && (
        <p
          className={`mt-2 ${msg.kind === "error" ? "error" : "muted"}`}
          role={msg.kind === "error" ? "alert" : undefined}
        >
          {msg.text}
          {msg.devLink && (
            <>
              {" "}
              <a href={msg.devLink}>Open the confirmation link</a>
            </>
          )}
        </p>
      )}
    </div>
  );
}

/**
 * The operator's first step after signing in: confirm the ADMIN_CALLSIGNS call with OPERATOR_SECRET on the
 * gateway host. Shows the exact command for the Docker stack and for a plain checkout.
 */
function OperatorVerify(props: { callsign: string; onDone: () => void }) {
  const script = `node tools/admin/verify-call.mjs ${props.callsign}`;
  return (
    <div>
      <p className="muted fine">
        You&apos;re this instance&apos;s operator. Confirm <span className="mono">{props.callsign}</span> with the
        operator secret to open instance admin — run one of these on the gateway host:
      </p>
      <CommandBlock label="Docker stack (in deploy/)" command={`docker compose exec gateway ${script}`} />
      <CommandBlock
        label="From a checkout (OPERATOR_SECRET from your .env)"
        command={`BASE=${trimTrailingSlashes(API_BASE || window.location.origin)} OPERATOR_SECRET=<operator secret> ${script}`}
      />
      <Button onClick={props.onDone}>I&apos;ve run it — check again</Button>
    </div>
  );
}
