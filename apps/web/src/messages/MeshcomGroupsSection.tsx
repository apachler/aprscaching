// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { getMeshcomGroupMessages, type MeshcomGroup, type MeshcomGroupMessage } from "../api.js";
import { useFmt } from "../format.js";
import { EmptyState, ErrorState, LoadMore, usePaged, InfoTip } from "../ui/index.js";

/** How the receiving node heard a group message, in words. */
const HEARD: Record<NonNullable<MeshcomGroupMessage["heard"]>, string> = {
  direct: "heard directly",
  relayed: "relayed on the mesh",
  server: "from the MeshCom server",
  node: "the node's own",
};

/** A group's name: its number, or "All" for the `*` group every node reads. */
export const groupName = (g: string) => (g === "*" ? "All (*)" : g);

/**
 * MeshCom group chat, read only: pick one of the groups this instance's MeshCom nodes heard, and read its
 * messages newest first. Group messages are addressed to a group number, not a station, so they never appear
 * in the callsign list under On the air.
 */
export function MeshcomGroupsSection(props: { groups: MeshcomGroup[] }) {
  const fmt = useFmt();
  const [picked, setPicked] = useState<string | null>(null);
  const group = picked ?? props.groups[0]?.group ?? null;
  const messages = usePaged(
    (cursor) =>
      group
        ? getMeshcomGroupMessages(group, cursor).then((r) => ({
            items: r.messages,
            nextCursor: r.nextCursor,
            hasMore: r.hasMore,
          }))
        : Promise.resolve({ items: [] as MeshcomGroupMessage[], nextCursor: null, hasMore: false }),
    [group],
  );

  return (
    <>
      <p className="muted">
        MeshCom group chat heard by this instance's MeshCom nodes. Sending to a group is not available yet.
      </p>
      {props.groups.length === 0 ? (
        <EmptyState>
          No MeshCom group has been heard recently. Group messages appear here as the nodes hear them.
        </EmptyState>
      ) : (
        <>
          <label>
            Group{" "}
            <InfoTip
              text="A MeshCom chat channel named by a number, such as 232; * reaches every node."
              label="What is a MeshCom group?"
            />
            <select aria-label="Group" value={group ?? ""} onChange={(e) => setPicked(e.target.value)}>
              {props.groups.map((g) => (
                <option key={g.group} value={g.group}>
                  {groupName(g.group)} · {g.messages} {g.messages === 1 ? "message" : "messages"}
                </option>
              ))}
            </select>
          </label>
          {messages.error && messages.items.length === 0 ? (
            <ErrorState onRetry={messages.reload} />
          ) : messages.items.length === 0 && !messages.loading ? (
            <EmptyState>This group has no messages the instance still keeps.</EmptyState>
          ) : (
            <ul className="msg-list" aria-label={`Messages in group ${groupName(group ?? "")}`}>
              {messages.items.map((m) => (
                <li key={m.id} className="msg-row">
                  <div className="msg-h">
                    <span className="msg-calls">
                      <span className="mono msg-from">{m.fromCall}</span>
                    </span>
                    {m.heard && (
                      <span className="muted fine">
                        {HEARD[m.heard]}
                        {m.receiver && (
                          <>
                            {" "}
                            by <span className="mono">{m.receiver}</span>
                          </>
                        )}
                      </span>
                    )}
                    <span className="muted msg-when">{fmt.ago(m.ts)}</span>
                  </div>
                  <div className="comment msg-body">{m.body}</div>
                </li>
              ))}
            </ul>
          )}
          <LoadMore hasMore={messages.hasMore} loading={messages.loading} onClick={messages.loadMore} />
        </>
      )}
    </>
  );
}
