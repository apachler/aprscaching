// SPDX-License-Identifier: AGPL-3.0-or-later
import { Icon, Button } from "../ui/index.js";
import { TAB_ITEMS, type NavItem } from "../nav.js";

/**
 * The mobile bottom tab bar: the `tab` destinations of the nav table, with the find/hide action in the
 * middle. `active` is the lit tab's key (see nav.ts activeKey). Hidden at ≥1024px, where the rail shows.
 */
export function TabBar(props: {
  active: string;
  onNav: (key: NavItem["key"]) => void;
  onFab: () => void;
  fabLabel: "Log" | "Hide";
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
            name={props.fabLabel === "Log" ? "check" : "plus"}
            cp437={props.fabLabel === "Log" ? "√" : "+"}
            size={26}
          />
        </span>
        <span>{props.fabLabel}</span>
      </Button>
      {TAB_ITEMS.slice(half).map(tab)}
    </nav>
  );
}
