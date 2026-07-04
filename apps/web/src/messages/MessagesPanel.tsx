// SPDX-License-Identifier: AGPL-3.0-or-later
import { getMessages } from "../api.js";
import { useFmt } from "../format.js";
import { Panel, Badge, EmptyState, ErrorState, LoadMore, usePaged, Ico } from "../ui/index.js";

/**
 * MessagesPanel — APRS text messaging as a first-class platform surface (its own inbox), NOT the BBS.
 * BBS is store-and-forward mail/bulletins between platform accounts; APRS messages are live radio
 * messages addressed to callsigns. They are deliberately kept separate — a BBS personal message is
 * never sourced from APRS. Your own callsign's traffic is highlighted. Read view; transmit is gated
 * on callsign control-verification and lives with the RF path.
 */
export function MessagesPanel(props: { callsign: string; onClose: () => void }) {
  const fmt = useFmt();
  const me = props.callsign.toUpperCase();
  const messages = usePaged(
    (cursor) =>
      getMessages(false, cursor).then((r) => ({ items: r.messages, nextCursor: r.nextCursor, hasMore: r.hasMore })),
    [],
  );

  const mine = (call: string | null) => !!call && call.toUpperCase().split("-")[0] === me.split("-")[0];

  return (
    <Panel
      title={
        <>
          <Ico e="✉ " />
          Messages
        </>
      }
      onClose={props.onClose}
    >
      <p className="muted">
        Live APRS text messages. Your callsign's traffic is highlighted. This is radio messaging — separate from BBS
        mail.
      </p>
      {messages.error && messages.items.length === 0 ? (
        <ErrorState onRetry={messages.reload} />
      ) : messages.items.length === 0 ? (
        <EmptyState>
          No APRS messages yet. Messages addressed to or from stations appear here as they're heard.
        </EmptyState>
      ) : (
        <ul className="msg-list">
          {messages.items.map((m) => (
            <li key={m.id} className={`msg-row${mine(m.fromCall) || mine(m.toCall) ? " mine" : ""}`}>
              <div className="msg-h">
                <span className="mono msg-from">{m.fromCall}</span>
                <span className="muted" aria-hidden="true">
                  →
                </span>
                <span className="mono msg-to">{m.toCall ?? "ALL"}</span>
                {m.direction === "out" && <Badge>sent</Badge>}
                <span className="spacer" />
                <span className="muted msg-when">{fmt.ago(m.ts)}</span>
              </div>
              <div className="comment msg-body">{m.body}</div>
            </li>
          ))}
        </ul>
      )}
      <LoadMore hasMore={messages.hasMore} loading={messages.loading} onClick={messages.loadMore} />
    </Panel>
  );
}
