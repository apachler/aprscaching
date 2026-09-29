// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useState } from "react";
import {
  startAprsVerify,
  getVerifyStatus,
  changeCallsign,
  addCallsign,
  listCallsigns,
  type HeldCallsign,
  type VerifyChallenge,
} from "../api.js";
import { Group, Badge, Icon, Advanced, copyText, useToast } from "../ui/index.js";
import { useFmt } from "../format.js";

type Session = {
  callsign: string;
  verified: boolean;
  email: string | null;
  signedIn: boolean;
  signOut: () => void;
  refresh: () => void;
};
const baseCall = (c: string) => c.toUpperCase().split("-")[0] ?? "";

/** How often the open challenge polls for the site having heard the message. */
const POLL_MS = 5000;

type Challenge = VerifyChallenge & { callsign: string };
type ChallengeState = "waiting" | "verified" | "expired";

/** Settings → Account: the signed-in identity, the account's held base callsigns (switch / add /
 *  verify each), and sign-out. An account is a person who may hold several licensed base calls;
 *  switching the active call never re-verifies, only adding a new one does. */
export function AccountSettings(props: {
  session: Session;
  onSignIn: () => void;
  /** The account holds this instance's ADMIN_CALLSIGNS call but has not confirmed it yet. */
  operatorPending?: boolean;
}) {
  const { callsign, email, signedIn, signOut, refresh } = props.session;
  const active = baseCall(callsign);
  const [held, setHeld] = useState<HeldCallsign[]>([]);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [chState, setChState] = useState<ChallengeState>("waiting");
  const [pollErr, setPollErr] = useState(false);
  const fmt = useFmt();
  const toast = useToast();
  const [newCs, setNewCs] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "error" } | null>(null);

  const reload = useCallback(async () => {
    if (!signedIn) return;
    try {
      setHeld((await listCallsigns()).callsigns);
    } catch {
      /* keep prior list */
    }
  }, [signedIn]);
  useEffect(() => {
    void reload();
  }, [reload, callsign]);

  async function setActive(cs: string) {
    setBusy(true);
    setMsg(null);
    try {
      await changeCallsign(cs);
      setMsg({ text: `Now operating as ${cs}.`, kind: "ok" });
      refresh();
      await reload();
    } catch (e) {
      setMsg({ text: (e as Error).message.replace(/^.*?: /, ""), kind: "error" });
    } finally {
      setBusy(false);
    }
  }
  async function startVerify(cs: string) {
    setBusy(true);
    setMsg(null);
    try {
      const c = await startAprsVerify(cs);
      setChallenge({ ...c, callsign: cs });
      setChState("waiting");
      setPollErr(false);
    } catch (e) {
      setMsg({ text: (e as Error).message, kind: "error" });
    } finally {
      setBusy(false);
    }
  }
  async function copyMessage(c: Challenge) {
    toast((await copyText(c.text)) ? "Message copied" : "Couldn't copy — type it on the radio as shown");
  }

  // Poll until the receiving site hears the message or the code expires.
  useEffect(() => {
    if (!challenge || chState !== "waiting") return;
    let stopped = false;
    const tick = async () => {
      if (Date.now() / 1000 > challenge.expiresAt) {
        setChState("expired");
        return;
      }
      try {
        const r = await getVerifyStatus(challenge.callsign);
        if (stopped) return;
        setPollErr(false);
        if (r.verified) {
          setChState("verified");
          if (challenge.callsign === active) refresh();
          await reload();
        }
      } catch {
        if (!stopped) setPollErr(true);
      }
    };
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [challenge, chState, active, refresh, reload]);

  async function addNew() {
    const n = baseCall(newCs.trim());
    if (n.length < 3) {
      setMsg({ text: "Enter a callsign to add.", kind: "error" });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await addCallsign(n);
      setNewCs("");
      setMsg({ text: `Added ${n} — verify it below to enable announce + leaderboard credit.`, kind: "ok" });
      await reload();
    } catch (e) {
      setMsg({ text: (e as Error).message.replace(/^.*?: /, ""), kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  if (!signedIn) {
    return (
      <Group title="Account" status="signed out">
        <p className="muted">Sign in with your callsign to claim and log your finds.</p>
        <div className="row end">
          <button className="primary" onClick={props.onSignIn}>
            Sign in
          </button>
        </div>
      </Group>
    );
  }
  return (
    <Group title="Account" status={active}>
      {props.operatorPending && (
        <p className="muted fine">
          You&apos;re this instance&apos;s operator. Confirm <span className="mono">{active}</span> with the operator
          CLI to open instance admin.
        </p>
      )}
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
            </div>
            <div className="setrow-c">
              {c.verified ? (
                <Badge kind="tierA" title="callsign-control verified">
                  <Icon name="check" size={12} /> verified
                </Badge>
              ) : (
                <button
                  className="link"
                  disabled={busy || challenge?.callsign === c.callsign}
                  onClick={() => void startVerify(c.callsign)}
                >
                  {busy && !challenge ? "starting…" : "verify"}
                </button>
              )}
              {!c.active && (
                <button disabled={busy} onClick={() => setActive(c.callsign)}>
                  Set active
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {challenge && (
        <section className="verify-code" aria-label={`Verify ${challenge.callsign}`}>
          {chState === "verified" ? (
            <p className="m-0" role="status">
              <Icon name="check" size={12} /> <span className="mono">{challenge.callsign}</span> is verified.
            </p>
          ) : (
            <>
              <p className="m-0">
                From <span className="mono">{challenge.callsign}</span> (any SSID), send this APRS message on the air:
              </p>
              <dl className="verify-msg">
                <dt>To</dt>
                <dd className="mono">{challenge.to}</dd>
                <dt>Message</dt>
                <dd className="mono">{challenge.text}</dd>
              </dl>
              <p className="muted fine m-0">
                It counts only when this instance&apos;s own receiving site hears it; a copy via APRS-IS does not.
              </p>
              {chState === "waiting" ? (
                <p className="muted mt-2 mb-0" role="status" aria-live="polite">
                  {pollErr
                    ? "Can't reach the server — still trying."
                    : `Listening for your message until ${fmt.time(challenge.expiresAt)}…`}
                </p>
              ) : (
                <p className="error mt-2 mb-0" role="status">
                  The code expired before the site heard it. Get a new code and transmit again.
                </p>
              )}
            </>
          )}
          <div className="row end mt-2">
            {chState === "verified" ? (
              <button onClick={() => setChallenge(null)}>Done</button>
            ) : (
              <>
                <button onClick={() => setChallenge(null)}>Cancel</button>
                {chState === "waiting" ? (
                  <button className="primary" onClick={() => void copyMessage(challenge)}>
                    Copy message
                  </button>
                ) : (
                  <button className="primary" disabled={busy} onClick={() => void startVerify(challenge.callsign)}>
                    {busy ? "Starting…" : "Get a new code"}
                  </button>
                )}
              </>
            )}
          </div>
        </section>
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
          <button className="primary" disabled={busy} onClick={addNew}>
            Add
          </button>
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
      <div className="row end mt-3">
        <button className="danger" onClick={signOut}>
          Sign out
        </button>
      </div>
      {msg && <p className={`mt-2 ${msg.kind === "error" ? "error" : "muted"}`}>{msg.text}</p>}
      <p className="muted fine mt-2">
        Switching your active call never re-verifies a call you already hold; only adding a new one does. Past finds
        stay attributed to the call they were logged with.
      </p>
    </Group>
  );
}
