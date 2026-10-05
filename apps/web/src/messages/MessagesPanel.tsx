// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { getMeshcomGroups, getMessages } from "../api.js";
import { useFmt } from "../format.js";
import {
  Panel,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadMore,
  Segmented,
  usePaged,
  useLoad,
  Icon,
  type SegmentOption,
} from "../ui/index.js";
import { usePlatform } from "../platform/PlatformContext.js";
import { Conversations } from "./Conversations.js";
import { MeshcomGroupsSection } from "./MeshcomGroupsSection.js";
import { TransportBadge } from "./transport.js";
import { isPersonMarker } from "./threads.js";
import { ContentMenu } from "../moderation/ContentMenu.js";

type Scope = "all" | "mine";
type View = "mine" | "air" | "groups";

/**
 * MessagesPanel — APRS and MeshCom text messaging as a first-class platform surface, NOT the BBS. The BBS
 * moves mail and bulletins the F6FBB way only; these are radio messages addressed to callsigns, and the two
 * never mix. Signed in, **Conversations** is the messenger: the operator's own messages by station, New message
 * and Reply, sent now or left in the Mailbox until the station is heard. **On the air** lists every message the
 * instance hears, with a **Mine** filter and Reply on the operator's own traffic. **MeshCom groups** reads the
 * group chat the instance's MeshCom nodes heard, read only, and appears only once a group has been heard.
 */
export function MessagesPanel(props: { onClose: () => void; onRadio?: () => void; onSignIn?: () => void }) {
  const { callsign, verified, session } = usePlatform();
  const fmt = useFmt();
  const me = callsign.toUpperCase();
  const base = me.split("-")[0] ?? "";
  const canMine = session.signedIn && base.length >= 3;
  const [scope, setScope] = useState<Scope>("all");
  const [view, setView] = useState<View>("mine");
  const [peer, setPeer] = useState<string | null>(null);
  const [service, setService] = useState<string | null>(null);
  const mineOnly = canMine && scope === "mine";
  // the group view only where a MeshCom node has heard a group
  const groups = useLoad(() => getMeshcomGroups().then((r) => r.groups), []);
  const hasGroups = (groups.data?.length ?? 0) > 0;
  const views: SegmentOption<View>[] = [
    ...(canMine ? [{ value: "mine" as const, label: "Conversations", title: "Your own messages, by station" }] : []),
    { value: "air", label: "On the air", title: "APRS messages this instance heard, on the air and on APRS-IS" },
    ...(hasGroups
      ? [
          {
            value: "groups" as const,
            label: "MeshCom groups",
            title: "Group chat heard by this instance's MeshCom nodes",
          },
        ]
      : []),
  ];
  const shown: View = views.some((v) => v.value === view) ? view : "air";
  const messages = usePaged(
    (cursor) =>
      shown !== "air"
        ? Promise.resolve({ items: [], nextCursor: null, hasMore: false })
        : getMessages(false, cursor, 30, undefined, mineOnly ? base : undefined).then((r) => {
            setService(r.serviceCall?.toUpperCase() ?? null);
            return { items: r.messages, nextCursor: r.nextCursor, hasMore: r.hasMore };
          }),
    [mineOnly, base, shown],
  );

  // The service call shares the sysop's base call but speaks for the instance, so its side is never "yours".
  const mine = (call: string | null) =>
    canMine && !!call && call.toUpperCase() !== service && call.toUpperCase().split("-")[0] === base;
  const reply = (call: string) => {
    setPeer(call.toUpperCase());
    setView("mine");
  };

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
      {views.length > 1 && <Segmented label="View" value={shown} onChange={setView} options={views} />}
      {shown === "mine" ? (
        <Conversations
          callsign={me}
          verified={verified}
          signedIn={session.signedIn}
          peer={peer}
          onPeer={setPeer}
          onRadio={props.onRadio}
        />
      ) : shown === "groups" ? (
        <MeshcomGroupsSection groups={groups.data ?? []} />
      ) : (
        <>
          <p className="muted">
            Live APRS text messages. Your callsign's traffic is highlighted. This is radio messaging, separate from the
            BBS.
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
              {messages.items.map((m) => {
                // Reply goes to the other side of a message that is the operator's own
                const other = mine(m.fromCall) ? m.toCall : mine(m.toCall) ? m.fromCall : null;
                return (
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
                      <TransportBadge transport={m.transport} direction={m.direction} />
                      {m.direction === "tx" && <Badge>sent</Badge>}
                      <span className="muted msg-when">{fmt.ago(m.ts)}</span>
                      {m.fromCall !== "WITHDRAWN" && (
                        <ContentMenu
                          target={{ kind: "message", id: m.id, label: `message from ${m.fromCall}` }}
                          own={mine(m.fromCall)}
                          onRemoved={messages.reload}
                        />
                      )}
                    </div>
                    <div className="comment msg-body">
                      {m.fromCall === "WITHDRAWN" && !m.body ? (
                        <span className="muted">Withdrawn: the sender erased their account.</span>
                      ) : (
                        m.body
                      )}
                    </div>
                    {other && !isPersonMarker(other) && (
                      <Button
                        variant="quiet"
                        onClick={() => reply(other)}
                        hint={`Open your conversation with ${other}`}
                      >
                        Reply
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <LoadMore hasMore={messages.hasMore} loading={messages.loading} onClick={messages.loadMore} />
          {!session.signedIn && (
            <div className="msg-send">
              <p className="muted fine">Sign in to write messages and see your own conversations.</p>
              {props.onSignIn && <Button onClick={props.onSignIn}>Sign in</Button>}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
