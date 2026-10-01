// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * NavRail — the operator nav rail shown beside the map at ≥1024px (the denser shack context).
 * Real <nav>/<button> with the inline-SVG Icon set. Hidden below the breakpoint (CSS). The core
 * destinations come from the nav table (nav.ts); Shack apps the user has PINNED render after Shack.
 * The Admin item shows only to this instance's operator (and every admin write is gated server-side).
 */
import { Icon, type IconName, Button } from "./ui/index.js";
import { NAV_ITEMS, type NavItem } from "./nav.js";
import type { ShackApp } from "./shack/apps.js";

export function NavRail(props: {
  /** The lit item's key (see nav.ts activeKey). */
  active: string;
  onNav: (key: NavItem["key"]) => void;
  pinnedApps: ShackApp[];
  onLaunchApp: (id: ShackApp["id"]) => void;
  sysop: boolean;
}) {
  const item = (key: string, icon: IconName, label: string, onClick: () => void, cls?: string) => (
    <Button
      key={key}
      className={`${props.active === key ? "on" : ""}${cls ? " " + cls : ""}`}
      onClick={onClick}
      title={label}
      aria-current={props.active === key ? "page" : undefined}
      data-tour={key === "nearby" ? "nearby" : undefined}
    >
      <Icon name={icon} size={21} />
      <span>{label}</span>
    </Button>
  );
  const core = (section: NavItem["section"]) =>
    NAV_ITEMS.filter((i) => i.section === section && (!i.sysop || props.sysop)).map((i, n) =>
      item(i.key, i.icon, i.label, () => props.onNav(i.key), section === "bottom" && n === 0 ? "rail-sp" : undefined),
    );
  return (
    <nav className="rail" aria-label="Primary">
      {core("top")}
      {props.pinnedApps.length > 0 && <span className="rail-div" aria-hidden="true" />}
      {props.pinnedApps.map((app) => item(app.id, app.icon, app.label, () => props.onLaunchApp(app.id), "rail-pinned"))}
      {core("bottom")}
    </nav>
  );
}
