// SPDX-License-Identifier: AGPL-3.0-or-later
import { Ico } from "../ui/index.js";
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
    <button
      key={item.key}
      className={props.active === item.key ? "on" : ""}
      aria-current={props.active === item.key ? "page" : undefined}
      onClick={() => props.onNav(item.key)}
      data-tour={item.key === "nearby" ? "nearby" : undefined}
    >
      <span className="ic">
        <Ico e={item.tab!.glyph} c={item.tab!.cog} />
      </span>
      <span>{item.label}</span>
    </button>
  );
  const half = Math.ceil(TAB_ITEMS.length / 2);
  return (
    <nav className="tabbar" aria-label="Primary">
      {TAB_ITEMS.slice(0, half).map(tab)}
      <button className="fab" onClick={props.onFab}>
        <span className="ic">{props.fabLabel === "Log" ? "✓" : "＋"}</span>
        <span>{props.fabLabel}</span>
      </button>
      {TAB_ITEMS.slice(half).map(tab)}
    </nav>
  );
}
