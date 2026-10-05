// SPDX-License-Identifier: AGPL-3.0-or-later
import { Button, Icon, Sheet } from "../ui/index.js";
import { MORE_ITEMS, NAV_LINKS, type NavItem, type PinnedItem, type View } from "../nav.js";

/**
 * The phone's More sheet: every destination the desktop rail offers that is not a tab (You, Messages, Ranks, the
 * Shack, Offline, Settings, and Admin for the operator), then the user's pinned Shack apps and tools, then the
 * manual, from the same nav table and pins so the two never drift. A dot marks a destination that needs attention, with words for a screen reader.
 */
export function MoreSheet(props: {
  active: string;
  attention: ReadonlySet<string>;
  sysop: boolean;
  onPick: (key: NavItem["key"]) => void;
  pinned: PinnedItem[];
  onOpen: (view: View) => void;
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
              <span>
                {i.label}
                <span className="more-hint">{i.hint}</span>
              </span>
              {props.attention.has(i.key) && <span className="nav-dot" aria-hidden="true" />}
            </Button>
          </li>
        ))}
        {props.pinned.map((p) => (
          <li key={p.key}>
            <Button
              className={`more-item${props.active === p.key ? " on" : ""}`}
              aria-current={props.active === p.key ? "page" : undefined}
              onClick={() => props.onOpen(p.view)}
            >
              <Icon name={p.icon} size={20} />
              <span>
                {p.label}
                <span className="more-hint">{p.hint}</span>
              </span>
            </Button>
          </li>
        ))}
        {NAV_LINKS.map((l) => (
          <li key={l.key}>
            <a className="more-item" href={l.href} target="_blank" rel="noopener">
              <Icon name={l.icon} size={20} />
              <span>
                {l.label}
                <Icon name="external" size={12} cp437="" className="ext-ic" />
                <span className="more-hint">{l.hint}</span>
              </span>
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </li>
        ))}
      </ul>
      <span id="more-attn" className="sr-only">
        needs attention
      </span>
    </Sheet>
  );
}
