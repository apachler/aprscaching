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
import { MailboxSection } from "./MailboxSection.js";
import { MeshcomGroupsSection } from "./MeshcomGroupsSection.js";
import { TransportBadge } from "./transport.js";
import { TERMS } from "../terms.js";

type Scope = "all" | "mine";
type View = "air" | "mailbox" | "groups";

/**
 * MessagesPanel — APRS and MeshCom text messaging as a first-class platform surface, NOT the BBS. The BBS
 * moves mail and bulletins the F6FBB way only; these are radio messages addressed to callsigns, and the two
 * never mix. **On the air** lists the messages the instance hears: your own callsign's traffic is highlighted,
 * and **Mine** narrows the list to it. **Mailbox** leaves a message for a station, which the instance sends on
 * the air when it next hears it. **MeshCom groups** reads the group chat the instance's MeshCom nodes heard, and
 * appears only once a group has been heard. Each message names the network that carried it. Transmitting from your own radio is gated on callsign control-verification
 * and lives with the RF path in Settings → My radio.
 */
export function MessagesPanel(props: { onClose: () => void; onRadio?: () => void; onSignIn?: () => void }) {
  const { callsign, session } = usePlatform();
  const fmt = useFmt();
  const me = callsign.toUpperCase();
  const base = me.split("-")[0] ?? "";
  const canMine = base.length >= 3;
  const [scope, setScope] = useState<Scope>("all");
  const [view, setView] = useState<View>("air");
  const [service, setService] = useState<string | null>(null);
  const mineOnly = canMine && scope === "mine";
  // the group view only where a MeshCom node has heard a group
  const groups = useLoad(() => getMeshcomGroups().then((r) => r.groups), []);
  const hasGroups = (groups.data?.length ?? 0) > 0;
  const views: SegmentOption<View>[] = [
    { value: "air", label: "On the air", title: "APRS messages this instance heard, on the air and on APRS-IS" },
    ...(canMine ? [{ value: "mailbox" as const, label: "Mailbox", title: TERMS.mailbox }] : []),
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
      getMessages(false, cursor, 30, undefined, mineOnly ? base : undefined).then((r) => {
        setService(r.serviceCall?.toUpperCase() ?? null);
        return {
          items: r.messages,
          nextCursor: r.nextCursor,
          hasMore: r.hasMore,
        };
      }),
    [mineOnly, base],
  );

  // The service call shares the sysop's base call but speaks for the instance, so its side is never "yours".
  const mine = (call: string | null) =>
    !!call && call.toUpperCase() !== service && call.toUpperCase().split("-")[0] === base;

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
      {shown === "mailbox" ? (
        <MailboxSection callsign={me} />
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
                    <TransportBadge transport={m.transport} direction={m.direction} />
                    {m.direction === "tx" && <Badge>sent</Badge>}
                    <span className="muted msg-when">{fmt.ago(m.ts)}</span>
                  </div>
                  <div className="comment msg-body">
                    {m.fromCall === "WITHDRAWN" && !m.body ? (
                      <span className="muted">Withdrawn: the sender erased their account.</span>
                    ) : (
                      m.body
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <LoadMore hasMore={messages.hasMore} loading={messages.loading} onClick={messages.loadMore} />
        </>
      )}
      {props.onRadio && shown !== "groups" && (
        <div className="msg-send">
          {session.signedIn ? (
            <>
              <p className="muted fine">
                To send a message, connect a TNC in <strong>Settings → My radio (browser)</strong> and switch on
                transmit.
              </p>
              <Button onClick={props.onRadio}>Open My radio</Button>
            </>
          ) : (
            <>
              <p className="muted fine">
                To send a message from your own radio, sign in first, then connect a TNC in{" "}
                <strong>Settings → My radio (browser)</strong>.
              </p>
              {props.onSignIn && <Button onClick={props.onSignIn}>Sign in</Button>}
            </>
          )}
        </div>
      )}
    </Panel>
  );
}
