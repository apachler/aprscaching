// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * PacketRoute — the path a stored packet took to this instance, drawn as a chain: the sender, each digipeater
 * (taken, or requested and not taken), the receiving station or IGate, APRS-IS with its q-construct, and the
 * instance. A badge says which tier the packet supports on its own and one line says why, so a reader sees what
 * separates a Tier-A hearing (an attested site's own receiver) from a Tier-C APRS-IS copy.
 *
 * The chain runs down the panel where it is narrow and across where it has room (a container query in
 * styles/components/data.css). With no route it shows `empty`, the reason none is on record.
 */
import type { PacketRouteInfo } from "@aprscaching/shared";
import { Badge, Icon, InfoTip, type IconName } from "../ui/index.js";
import { TERMS } from "../terms.js";
import { routeView, type HopRole } from "./route.js";

/** Each leg's line icon, and the CP437 glyph Phosphor draws in its place. */
const ROLE_ICON: Record<HopRole, { name: IconName; cp437: string }> = {
  origin: { name: "radio", cp437: "☼" },
  digipeater: { name: "signal", cp437: "↕" },
  internet: { name: "link", cp437: "∞" },
  receiver: { name: "antenna", cp437: "▼" },
  igate: { name: "handover", cp437: "↑" },
  "aprs-is": { name: "server", cp437: "≡" },
  gateway: { name: "node", cp437: "■" },
};

export function PacketRoute(props: {
  route: PacketRouteInfo | null | undefined;
  /** Shown when there is no route: why none is on record. */
  empty: string;
  /** A further line under the reason, from the surface that knows more (a find's own tier). */
  note?: string | null;
}) {
  if (!props.route) {
    return (
      <div className="proute">
        <p className="proute-empty muted">{props.empty}</p>
      </div>
    );
  }
  const v = routeView(props.route);
  // one InfoTip per term: a path of three digipeaters explains "digipeater" once
  const explained = new Set<string>();
  return (
    <div className="proute">
      <div className="proute-h">
        <Badge
          kind={v.evidence === "A" ? "tierA" : "tierC"}
          title={
            v.evidence === "A"
              ? "An attested site's own receiver heard this packet"
              : "No receiver this instance attests heard this packet"
          }
        >
          Tier {v.evidence} evidence
        </Badge>
        <InfoTip text={TERMS.provenance} label="What is a packet route?" />
      </div>
      <ol className="proute-hops" aria-label="Route, from the sender to this instance">
        {v.hops.map((h, i) => {
          const tip = h.term && !explained.has(h.term) ? h.term : null;
          if (tip) explained.add(tip);
          return (
            <li key={i} className="proute-hop" data-state={h.state}>
              <span className="proute-mark" aria-hidden="true">
                <Icon name={ROLE_ICON[h.role].name} size={14} cp437={ROLE_ICON[h.role].cp437} />
              </span>
              <span className="proute-text">
                {h.call && <span className="proute-call mono">{h.call}</span>}
                <span className="proute-label">
                  {h.label}
                  {tip && <InfoTip text={TERMS[tip]} label={`What is ${termName(tip)}?`} />}
                </span>
                {h.sub && <span className="proute-sub">{h.sub}</span>}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="proute-why">{v.why}</p>
      {props.note && <p className="proute-why muted">{props.note}</p>}
    </div>
  );
}

/** The glossary term as a phrase for an InfoTip's name. */
function termName(term: keyof typeof TERMS): string {
  const names: Partial<Record<keyof typeof TERMS, string>> = {
    "attested-site": "an attested site",
    "aprs-is": "APRS-IS",
    "q-construct": "a q-construct",
    igate: "an IGate",
    digipeater: "a digipeater",
    axudp: "an AXUDP link",
  };
  return names[term] ?? term;
}
