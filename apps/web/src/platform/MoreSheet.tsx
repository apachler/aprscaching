// SPDX-License-Identifier: AGPL-3.0-or-later
import { Button, Icon, Sheet } from "../ui/index.js";
import { MORE_ITEMS, type MoreItem } from "../nav.js";

/**
 * The phone's More sheet: every destination the desktop rail offers that is not a tab (You, Messages, Ranks, the
 * Shack, Offline, Settings, the manual, and Admin for the operator), from the same nav table so the two never drift.
 * A dot marks a destination that needs attention, with words for a screen reader.
 */
export function MoreSheet(props: {
  active: string;
  attention: ReadonlySet<string>;
  sysop: boolean;
  onPick: (key: MoreItem["key"]) => void;
  onClose: () => void;
}) {
  const items = MORE_ITEMS.filter((i) => !i.sysop || props.sysop);
  return (
    <Sheet title="More" edge="bottom" onClose={props.onClose}>
      <ul className="more-list">
        {items.map((i) => (
          <li key={i.key}>
            <Button
              className={`more-item${props.active === i.key ? " on" : ""}`}
              aria-current={props.active === i.key ? "page" : undefined}
              aria-describedby={props.attention.has(i.key) ? "more-attn" : undefined}
              onClick={() => props.onPick(i.key)}
            >
              <Icon name={i.icon} size={20} />
              <span>{i.label}</span>
              {props.attention.has(i.key) && <span className="nav-dot" aria-hidden="true" />}
            </Button>
          </li>
        ))}
      </ul>
      <span id="more-attn" className="sr-only">
        needs attention
      </span>
    </Sheet>
  );
}
