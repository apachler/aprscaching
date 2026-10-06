// SPDX-License-Identifier: AGPL-3.0-or-later
import { Icon, Button } from "../ui/index.js";
import { TAB_ITEMS, type NavItem } from "../nav.js";

/**
 * The mobile bottom tab bar: the `tab` destinations of the nav table, with the find/hide action in the
 * middle and More last, which opens the sheet of every other destination (MoreSheet). `active` is the lit tab's
 * key (see nav.ts activeKey); More lights while one of its destinations is open. Hidden at ≥1024px, where the
 * rail shows.
 */
export function TabBar(props: {
  active: string;
  onNav: (key: NavItem["key"]) => void;
  onFab: () => void;
  /** Log a find, post a note (an open cache that takes no find from this player: their own, or an inactive one), or hide one. */
  fabLabel: "Log" | "Note" | "Hide";
  onMore: () => void;
  /** One of More's destinations is open. */
  moreActive: boolean;
  /** One of More's destinations needs attention: the More tab carries the dot. */
  moreAttention: boolean;
}) {
  const tab = (item: NavItem) => (
    <Button
      key={item.key}
      className={props.active === item.key ? "on" : ""}
      aria-current={props.active === item.key ? "page" : undefined}
      onClick={() => props.onNav(item.key)}
      data-tour={item.key === "nearby" ? "nearby" : undefined}
    >
      <span className="ic">
        <Icon name={item.icon} cp437={item.tab!.cog} size={22} />
      </span>
      <span>{item.label}</span>
    </Button>
  );
  const half = Math.ceil(TAB_ITEMS.length / 2);
  return (
    <nav className="tabbar" aria-label="Primary">
      {TAB_ITEMS.slice(0, half).map(tab)}
      <Button className="fab" onClick={props.onFab}>
        <span className="ic">
          <Icon
            name={props.fabLabel === "Log" ? "check" : props.fabLabel === "Note" ? "edit" : "plus"}
            cp437={props.fabLabel === "Log" ? "√" : props.fabLabel === "Note" ? "¶" : "+"}
            size={26}
          />
        </span>
        <span>{props.fabLabel}</span>
      </Button>
      {TAB_ITEMS.slice(half).map(tab)}
      <Button
        className={props.moreActive ? "on" : ""}
        aria-current={props.moreActive ? "page" : undefined}
        aria-haspopup="dialog"
        aria-describedby={props.moreAttention ? "tab-attn" : undefined}
        onClick={props.onMore}
      >
        <span className="ic">
          <Icon name="menu" cp437="≡" size={22} />
          {props.moreAttention && <span className="nav-dot" aria-hidden="true" />}
        </span>
        <span>More</span>
      </Button>
      {/* the words of the attention dot, outside the button so they describe it without joining its name */}
      <span id="tab-attn" className="sr-only">
        needs attention
      </span>
    </nav>
  );
}
