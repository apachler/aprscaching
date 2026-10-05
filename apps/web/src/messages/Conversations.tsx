// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Conversations — the operator's own APRS messages as a messenger: one conversation per station, a New message
 * action, Reply in every conversation with a station that still holds its call, and the delivery state of each
 * message. A new message goes out now (from the operator's own radio when it is connected and transmit is on,
 * otherwise through the instance to APRS-IS), or waits in the Mailbox until the instance next hears the station. Every path puts the text on the air in the
 * operator's name, so sending is gated on callsign control-verification and says so before anything is typed.
 */
import { useId, useMemo, useState } from "react";
import { encodeAprsMessage } from "@aprscaching/aprs";
import {
  getMailbox,
  getMessages,
  leaveMailboxMessage,
  recordSentMessage,
  sendAprsMessage,
  withdrawMailboxMessage,
  errorText,
} from "../api.js";
import { useFmt } from "../format.js";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadMore,
  Segmented,
  usePaged,
  useLoad,
  usePoll,
  useToast,
  Icon,
  InfoTip,
} from "../ui/index.js";
import { radioLink, useRadioLink } from "../rf/RadioLinkHost.js";
import { LINK_LABEL } from "../rf/radioLink.js";
import { nextMsgNo } from "../rf/msgNo.js";
import { TERMS } from "../terms.js";
import { TransportBadge } from "./transport.js";
import {
  correspondents,
  isPersonMarker,
  MAILBOX_SENT_NOTE,
  nowRoute,
  sendBlocked,
  textMax,
  threadKey,
  threadsOf,
  validRecipient,
  type Delivery,
  type ItemState,
  type Thread,
  type ThreadItem,
} from "./threads.js";

/** How a conversation with an erased person, or a call's former holder, is named: there is no station to show. */
const WITHDRAWN_LABEL = "Withdrawn correspondents";
const WITHDRAWN_NOTE =
  "These people erased their accounts or no longer hold the call they wrote from, so there is no one to reply to.";

/** Each state in words, with the line its hint gives. */
const STATE: Record<ItemState, { label: string; hint: string; kind?: string }> = {
  queued: { label: "queued", hint: "Waiting for the instance's ingest box to send it to APRS-IS" },
  sent: { label: "sent", hint: "Sent; no acknowledgement heard yet" },
  acked: { label: "acked", hint: "The station acknowledged it", kind: "found" },
  failed: { label: "not sent", hint: "The instance could not send it within the hour", kind: "dnf" },
  waiting: { label: "waiting until heard", hint: "The Mailbox sends it the next time the instance hears the station" },
  "sent-no-ack": { label: "sent, no ack yet", hint: "Sent from the Mailbox; the station has not acknowledged it yet" },
  delivered: { label: "delivered", hint: "The station acknowledged it", kind: "found" },
  undelivered: { label: "sent, never acked", hint: "Sent from the Mailbox, but the station never acknowledged it" },
  expired: { label: "expired", hint: "Not heard within 7 days, so the Mailbox dropped it", kind: "dnf" },
};

export function Conversations(props: {
  callsign: string;
  verified: boolean;
  signedIn: boolean;
  /** Open a conversation with this station first (a Reply from On the air). */
  peer?: string | null;
  onPeer: (peer: string | null) => void;
  onRadio?: () => void;
}) {
  const fmt = useFmt();
  const toast = useToast();
  const me = props.callsign.toUpperCase();
  const base = me.split("-")[0] ?? "";
  const [composing, setComposing] = useState(false);
  const [service, setService] = useState<string | null>(null);
  const messages = usePaged(
    (cursor) =>
      getMessages(false, cursor, 50, undefined, base).then((r) => {
        setService(r.serviceCall?.toUpperCase() ?? null);
        return { items: r.messages, nextCursor: r.nextCursor, hasMore: r.hasMore };
      }),
    [base],
  );
  const box = useLoad(() => getMailbox(), [base]);
  const reload = () => {
    messages.reload();
    box.reload();
  };
  // delivery states move on their own (the box sends, the station acks): look again while the view is open
  usePoll(reload, 30_000, { immediate: false });

  const threads = useMemo(
    () => threadsOf(messages.items, box.data, me, service),
    [messages.items, box.data, me, service],
  );
  const openKey = props.peer ? threadKey(props.peer, service) : null;
  const open = openKey ? (threads.find((t) => t.peer === openKey) ?? null) : null;

  async function withdraw(id: number, to: string) {
    try {
      await withdrawMailboxMessage(id);
      toast(`Message for ${to} withdrawn`);
      box.reload();
    } catch (e) {
      toast(errorText(e));
    }
  }

  const compose = (to: string | null) => (
    <Compose
      key={to ?? "new"}
      callsign={me}
      verified={props.verified}
      signedIn={props.signedIn}
      to={to}
      suggestions={correspondents(threads)}
      onRadio={props.onRadio}
      onSent={(peer) => {
        setComposing(false);
        props.onPeer(peer);
        reload();
      }}
    />
  );

  if (props.peer && openKey) {
    const peer = openKey;
    // a reply goes to the station as it was named (a Reply from On the air, a new message), else to the SSID of
    // the conversation's latest message
    const named = props.peer.toUpperCase();
    const replyTo = named !== peer ? named : (open?.replyTo ?? peer);
    const withdrawn = isPersonMarker(peer);
    return (
      <section aria-labelledby="thread-h">
        <div className="row between">
          <Button variant="quiet" onClick={() => props.onPeer(null)}>
            ← All conversations
          </Button>
        </div>
        <h3 className={`set-subh${withdrawn ? "" : " mono"}`} id="thread-h">
          {withdrawn ? WITHDRAWN_LABEL : peer}
        </h3>
        {!open ? (
          <EmptyState>No messages with {peer} yet. Write the first one below.</EmptyState>
        ) : (
          <ol className="msg-thread">
            {open.items.map((it) => (
              <ThreadRow key={it.key} it={it} peer={peer} fmt={fmt} onWithdraw={(id) => void withdraw(id, peer)} />
            ))}
          </ol>
        )}
        {withdrawn ? (
          <p className="inline-note">{WITHDRAWN_NOTE}</p>
        ) : (
          <>
            <h4 className="set-subh">Reply</h4>
            {compose(replyTo)}
          </>
        )}
      </section>
    );
  }

  return (
    <>
      <div className="row between">
        <p className="muted m-0">Your messages, one conversation per station.</p>
        <Button variant="primary" onClick={() => setComposing((v) => !v)} aria-expanded={composing}>
          <Icon name="edit" cp437="" className="lead-ic" />
          New message
        </Button>
      </div>
      {composing && compose(null)}
      {(messages.error && messages.items.length === 0) || (box.error && !box.data) ? (
        <ErrorState onRetry={reload}>Couldn&apos;t load your messages — check your connection and retry.</ErrorState>
      ) : threads.length === 0 ? (
        messages.loading || box.loading ? (
          <p className="muted" aria-busy="true">
            Loading your messages…
          </p>
        ) : (
          <EmptyState>
            No conversations yet. Messages from or to {base} appear here, and New message starts one.
          </EmptyState>
        )
      ) : (
        <ul className="msg-list">
          {threads.map((t) => (
            <li key={t.peer}>
              <ThreadLink t={t} fmt={fmt} onOpen={() => props.onPeer(t.peer)} />
            </li>
          ))}
        </ul>
      )}
      <LoadMore hasMore={messages.hasMore} loading={messages.loading} onClick={messages.loadMore} />
    </>
  );
}

function StateBadge(props: { state?: ItemState }) {
  if (!props.state) return null;
  const s = STATE[props.state];
  return (
    <Badge kind={s.kind} title={s.hint}>
      {s.label}
    </Badge>
  );
}

function ThreadLink(props: { t: Thread; fmt: ReturnType<typeof useFmt>; onOpen: () => void }) {
  const { t } = props;
  return (
    <Button className="msg-row msg-thread-link" onClick={props.onOpen}>
      <span className="msg-h">
        <span className="msg-calls">
          {t.withdrawn ? (
            <span className="msg-from">{WITHDRAWN_LABEL}</span>
          ) : (
            <span className="mono msg-from">{t.peer}</span>
          )}
          <span className="muted">
            {t.items.length} message{t.items.length === 1 ? "" : "s"}
          </span>
        </span>
        {t.last.dir === "out" && <StateBadge state={t.last.state} />}
        <span className="muted msg-when">{props.fmt.ago(t.last.ts)}</span>
      </span>
      <span className="comment msg-body">
        {t.last.dir === "out" ? "You: " : ""}
        {t.last.text}
      </span>
    </Button>
  );
}

function ThreadRow(props: {
  it: ThreadItem;
  /** The conversation's base call: a message to another SSID of it names that SSID. */
  peer: string;
  fmt: ReturnType<typeof useFmt>;
  onWithdraw: (id: number) => void;
}) {
  const { it } = props;
  return (
    <li className={`msg-row${it.dir === "out" ? " mine" : ""}`}>
      <div className="msg-h">
        <span className="msg-calls">
          {it.dir === "in" && isPersonMarker(it.from) ? (
            <span className="msg-from">{WITHDRAWN_LABEL}</span>
          ) : (
            <span className="mono msg-from">
              {it.dir === "out" ? `You (${it.from})${it.with !== props.peer ? ` to ${it.with}` : ""}` : it.from}
            </span>
          )}
        </span>
        {it.viaMailbox ? (
          <Badge title={TERMS.mailbox}>Mailbox</Badge>
        ) : (
          <TransportBadge transport={it.transport} direction={it.dir === "out" ? "tx" : "rx"} />
        )}
        {it.dir === "out" && <StateBadge state={it.state} />}
        {it.dir === "in" && it.state === "waiting" && <StateBadge state="waiting" />}
        <span className="muted msg-when">{props.fmt.ago(it.ts)}</span>
      </div>
      <div className="comment msg-body">{it.text}</div>
      {it.withdrawId != null && (
        <Button variant="quiet" onClick={() => props.onWithdraw(it.withdrawId!)}>
          Withdraw
        </Button>
      )}
      {it.viaMailbox && it.dir === "out" && it.state === "sent-no-ack" && <p className="muted">{MAILBOX_SENT_NOTE}</p>}
    </li>
  );
}

/** Write a message: to whom, the text, and how it is delivered. */
function Compose(props: {
  callsign: string;
  verified: boolean;
  signedIn: boolean;
  /** A reply: the recipient is fixed. */
  to: string | null;
  suggestions: string[];
  onRadio?: () => void;
  onSent: (peer: string) => void;
}) {
  const toast = useToast();
  const radio = useRadioLink();
  const listId = useId();
  const reasonId = useId();
  const [to, setTo] = useState(props.to ?? "");
  const [text, setText] = useState("");
  const [delivery, setDelivery] = useState<Delivery>("now");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const blocked = sendBlocked(props);
  const route = nowRoute(radio);
  const max = textMax(delivery, props.callsign);
  const recipient = to.trim().toUpperCase();
  const ready = !blocked && validRecipient(recipient) && text.trim().length > 0 && text.length <= max;

  async function send() {
    if (!ready) return;
    setBusy(true);
    setErr(null);
    const body = text.trim();
    try {
      if (delivery === "heard") {
        await leaveMailboxMessage(props.callsign, recipient, body);
        toast(`Message for ${recipient} left in the Mailbox`);
      } else if (route === "radio" && radioLink.canTransmit()) {
        // a numbered message asks the station to acknowledge it
        const msgNo = nextMsgNo();
        const from = radioLink.txCall();
        await radioLink.transmit(
          { src: from, dst: "APRS", path: ["WIDE1-1"], payload: encodeAprsMessage(recipient, body, msgNo) },
          "Messages",
        );
        // the message went out either way; a failed record only leaves it out of the conversation
        const recorded = await recordSentMessage({ from, to: recipient, text: body, msgNo }).then(
          () => true,
          () => false,
        );
        toast(
          recorded
            ? `Transmitted to ${recipient}`
            : `Transmitted to ${recipient}, but the instance could not record it, so it is missing from this conversation`,
        );
      } else {
        await sendAprsMessage({ to: recipient, text: body, msgNo: nextMsgNo() });
        toast(`Sent to ${recipient} through the instance`);
      }
      setText("");
      props.onSent(recipient);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const off = !!blocked || busy;
  return (
    <form
      className="msg-compose"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      {blocked && (
        <p className="inline-note" id={reasonId}>
          {blocked}
        </p>
      )}
      {props.to == null && (
        <label>
          To
          <input
            className="mono"
            value={to}
            list={listId}
            maxLength={9}
            autoComplete="off"
            spellCheck={false}
            placeholder="OE5XYZ or OE5XYZ-7"
            disabled={off}
            aria-describedby={blocked ? reasonId : undefined}
            onChange={(e) => setTo(e.target.value)}
          />
          <datalist id={listId}>
            {props.suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>
      )}
      <label>
        Message{" "}
        <span className={text.length > max ? "error" : "muted"}>
          ({text.length}/{max})
        </span>
        <input
          value={text}
          disabled={off}
          aria-describedby={blocked ? reasonId : undefined}
          aria-invalid={text.length > max || undefined}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <Segmented
        label="Delivery"
        value={delivery}
        onChange={setDelivery}
        options={[
          { value: "now", label: "Now", disabled: off },
          { value: "heard", label: "When next heard", disabled: off, title: TERMS.mailbox },
        ]}
      />
      <p className="muted fine">
        {delivery === "heard" ? (
          <>
            The Mailbox keeps it for 7 days and sends it as <span className="mono">de {props.callsign}: …</span> from
            the instance&apos;s service call when the station is heard.{" "}
            <InfoTip text={TERMS.mailbox} label="What is the Mailbox?" />
          </>
        ) : route === "radio" && radio.link ? (
          <>
            From your radio ({LINK_LABEL[radio.link]}) as <span className="mono">{radioLink.txCall()}</span>, with a
            number the station acknowledges.
          </>
        ) : (
          <>
            Through the instance to APRS-IS as <span className="mono">{props.callsign}</span>, with a number the station
            acknowledges. To send from your own radio, connect it and switch transmit on in My radio.
            {props.onRadio && (
              <>
                {" "}
                <Button variant="inline" onClick={props.onRadio}>
                  Open My radio
                </Button>
              </>
            )}
          </>
        )}
      </p>
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
      <div className="row end">
        <Button variant="primary" type="submit" disabled={!ready || busy}>
          {busy ? "Sending…" : delivery === "heard" ? "Leave message" : "Send"}
        </Button>
      </div>
    </form>
  );
}
