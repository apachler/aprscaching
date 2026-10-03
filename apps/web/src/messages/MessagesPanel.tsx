// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { getMessages } from "../api.js";
import { useFmt } from "../format.js";
import { Panel, Badge, Button, EmptyState, ErrorState, LoadMore, Segmented, usePaged, Icon } from "../ui/index.js";
import { usePlatform } from "../platform/PlatformContext.js";

type Scope = "all" | "mine";

/**
 * MessagesPanel — APRS text messaging as a first-class platform surface (its own inbox), NOT the BBS.
 * BBS is store-and-forward mail/bulletins between platform accounts; APRS messages are live radio
 * messages addressed to callsigns. They are deliberately kept separate — a BBS personal message is
 * never sourced from APRS. Your own callsign's traffic is highlighted, and **Mine** narrows the list to it,
 * which on a phone is the conversation worth reading. Read view; transmit is gated on callsign
 * control-verification and lives with the RF path in Settings → My radio.
 */
export function MessagesPanel(props: { onClose: () => void; onRadio?: () => void }) {
  const { callsign } = usePlatform();
  const fmt = useFmt();
  const me = callsign.toUpperCase();
  const base = me.split("-")[0] ?? "";
  const canMine = base.length >= 3;
  const [scope, setScope] = useState<Scope>("all");
  const mineOnly = canMine && scope === "mine";
  const messages = usePaged(
    (cursor) =>
      getMessages(false, cursor, 30, undefined, mineOnly ? base : undefined).then((r) => ({
        items: r.messages,
        nextCursor: r.nextCursor,
        hasMore: r.hasMore,
      })),
    [mineOnly, base],
  );

  const mine = (call: string | null) => !!call && call.toUpperCase().split("-")[0] === base;

  return (
    <Panel
      title={
        <>
          <Icon name="message" cp437="" className="lead-ic" />
          Messages
        </>
      }
      onClose={props.onClose}
    >
      <p className="muted">
        Live APRS text messages. Your callsign's traffic is highlighted. This is radio messaging — separate from BBS
        mail.
      </p>
      {canMine && (
        <Segmented
          label="Which messages"
          look="chips"
          value={scope}
          onChange={setScope}
          options={[
            { value: "all", label: "All" },
            { value: "mine", label: `Mine (${base})` },
          ]}
        />
      )}
      {messages.error && messages.items.length === 0 ? (
        <ErrorState onRetry={messages.reload} />
      ) : messages.items.length === 0 && !messages.loading ? (
        <EmptyState>
          {mineOnly
            ? `No messages from or to ${base} yet. They appear here as they're heard.`
            : "No APRS messages yet. Messages addressed to or from stations appear here as they're heard."}
        </EmptyState>
      ) : (
        <ul className="msg-list">
          {messages.items.map((m) => (
            <li key={m.id} className={`msg-row${mine(m.fromCall) || mine(m.toCall) ? " mine" : ""}`}>
              <div className="msg-h">
                <span className="msg-calls">
                  <span className="mono msg-from">{m.fromCall}</span>
                  <span className="muted" aria-hidden="true">
                    →
                  </span>
                  <span className="sr-only">to</span>
                  <span className="mono msg-to">{m.toCall ?? "ALL"}</span>
                </span>
                {m.direction === "tx" && <Badge>sent</Badge>}
                <span className="muted msg-when">{fmt.ago(m.ts)}</span>
              </div>
              <div className="comment msg-body">{m.body}</div>
            </li>
          ))}
        </ul>
      )}
      <LoadMore hasMore={messages.hasMore} loading={messages.loading} onClick={messages.loadMore} />
      {props.onRadio && (
        <div className="msg-send">
          <p className="muted fine">
            To send a message, connect a TNC in <strong>Settings → My radio (browser)</strong> and switch on transmit.
          </p>
          <Button onClick={props.onRadio}>Open Settings</Button>
        </div>
      )}
    </Panel>
  );
}
