// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { getMailbox, leaveMailboxMessage, withdrawMailboxMessage, type MailboxMessage } from "../api.js";
import { useFmt } from "../format.js";
import { Badge, Button, EmptyState, ErrorState, useLoad, useToast } from "../ui/index.js";
import { usePlatform } from "../platform/PlatformContext.js";
import { ContentMenu } from "../moderation/ContentMenu.js";

/** The longest APRS message text. */
const APRS_TEXT_MAX = 67;

const STATUS: Record<MailboxMessage["status"], string> = {
  held: "waiting",
  sent: "sent, no ack yet",
  delivered: "delivered",
  undelivered: "sent, never acked",
  expired: "expired",
};

/** What each state means for the sender. */
const STATUS_HINT: Record<MailboxMessage["status"], string> = {
  held: "Waiting until the instance hears the station on the air",
  sent: "Sent on the air; the station has not acknowledged it yet",
  delivered: "The station acknowledged it",
  undelivered: "Sent, but the station never acknowledged it",
  expired: "Not heard within 7 days, so it was dropped",
};

/**
 * The Mailbox: leave a short message for a callsign; the instance holds it until that station is heard on the
 * air, then sends it as an APRS message from its service call. Separate from the BBS, which moves its mail
 * the F6FBB way only. Lists what you left, with its state, and what waits for your calls.
 */
export function MailboxSection(props: { callsign: string }) {
  // the message goes out on the air under the sender's call, so only a control-verified callsign leaves one
  const { verified } = usePlatform();
  const fmt = useFmt();
  const toast = useToast();
  const from = props.callsign.toUpperCase();
  const max = APRS_TEXT_MAX - `de ${from}: `.length;
  const box = useLoad(() => getMailbox(), [from]);
  const [to, setTo] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function leave() {
    setBusy(true);
    setErr(null);
    try {
      await leaveMailboxMessage(from, to.trim().toUpperCase(), text.trim());
      toast(`Message for ${to.trim().toUpperCase()} left in the Mailbox`);
      setTo("");
      setText("");
      box.reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(m: MailboxMessage) {
    try {
      await withdrawMailboxMessage(m.id);
      toast(`Message for ${m.to} withdrawn`);
      box.reload();
    } catch (e) {
      toast((e as Error).message);
    }
  }

  const row = (m: MailboxMessage, mine: boolean) => (
    <li key={m.id} className="msg-row">
      <div className="msg-h">
        <span className="msg-calls">
          <span className="mono msg-from">{m.from}</span>
          <span className="muted" aria-hidden="true">
            →
          </span>
          <span className="sr-only">to</span>
          <span className="mono msg-to">{m.deliveredTo ?? m.to}</span>
        </span>
        <Badge title={STATUS_HINT[m.status]}>{STATUS[m.status]}</Badge>
        <span className="muted msg-when">{fmt.ago(m.createdAt)}</span>
        <ContentMenu
          target={{ kind: "mailbox", id: m.id, label: `message from ${m.from}` }}
          own={mine}
          onRemoved={box.reload}
        />
      </div>
      <div className="comment msg-body">{m.text}</div>
      {mine && (m.status === "held" || m.status === "sent") && (
        <Button onClick={() => void withdraw(m)}>Withdraw</Button>
      )}
    </li>
  );

  return (
    <section aria-labelledby="mailbox-h">
      <h3 className="set-subh" id="mailbox-h">
        Mailbox
      </h3>
      <p className="muted">
        Leave a message for a station. The instance sends it as an APRS message the next time it hears that station, and
        keeps it for 7 days. This is not the BBS.
      </p>
      {!verified && (
        <p className="inline-note" id="mailbox-locked">
          Verify your callsign to send over the air: the Mailbox sends your message under{" "}
          <span className="mono">{from}</span>. Verify it under Settings → Account.
        </p>
      )}
      <label>
        To
        <input
          value={to}
          disabled={!verified}
          aria-describedby={verified ? undefined : "mailbox-locked"}
          maxLength={9}
          autoComplete="off"
          spellCheck={false}
          placeholder="OE5XYZ or OE5XYZ-7"
          onChange={(e) => setTo(e.target.value)}
        />
      </label>
      <label>
        Message{" "}
        <span className="muted">
          ({text.length}/{max}, sent as <span className="mono">de {from}: …</span>)
        </span>
        <input
          value={text}
          maxLength={max}
          disabled={!verified}
          aria-describedby={verified ? undefined : "mailbox-locked"}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      <div className="row end">
        <Button
          variant="primary"
          disabled={!verified || busy || !to.trim() || !text.trim()}
          onClick={() => void leave()}
        >
          {busy ? "Leaving…" : "Leave message"}
        </Button>
      </div>

      {box.error && !box.data ? (
        <ErrorState onRetry={box.reload} />
      ) : box.data ? (
        <>
          <h4 className="set-subh">Waiting for you</h4>
          {box.data.received.length ? (
            <ul className="msg-list">{box.data.received.map((m) => row(m, false))}</ul>
          ) : (
            <EmptyState>No messages for your calls.</EmptyState>
          )}
          <h4 className="set-subh">You left</h4>
          {box.data.sent.length ? (
            <ul className="msg-list">{box.data.sent.map((m) => row(m, true))}</ul>
          ) : (
            <EmptyState>You have not left a message yet.</EmptyState>
          )}
        </>
      ) : (
        <p className="muted">Loading the Mailbox…</p>
      )}
    </section>
  );
}
