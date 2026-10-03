// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useState } from "react";
import {
  API_BASE,
  trimTrailingSlashes,
  changeCallsign,
  addCallsign,
  listCallsigns,
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
  const { callsign, email, signedIn, signOut, signOutEverywhere, refresh } = props.session;
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
              {c.isPrimary && <Badge title="the callsign your passkey is bound to">primary</Badge>}
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
      {email && (
        <div className="setrow">
          <div className="setrow-l">
            <div>Email</div>
          </div>
          <div className="setrow-c muted">{email}</div>
        </div>
      )}
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
