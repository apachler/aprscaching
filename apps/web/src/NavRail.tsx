// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * NavRail — the operator nav rail shown beside the map at ≥1024px (the denser shack context).
 * Real <nav>/<button> with the inline-SVG Icon set. Hidden below the breakpoint (CSS). The core
 * destinations come from the nav table (nav.ts); Shack apps the user has PINNED render after Shack.
 * The Admin item shows only to this instance's operator (and every admin write is gated server-side). The
 * links outside the app (the manual) close the rail, opening in a new tab.
 */
import { Icon, type IconName, Button, Hint } from "./ui/index.js";
import { NAV_ITEMS, NAV_LINKS, type NavItem } from "./nav.js";
import type { ShackApp } from "./shack/apps.js";

export function NavRail(props: {
  /** The lit item's key (see nav.ts activeKey). */
  active: string;
  onNav: (key: NavItem["key"]) => void;
  pinnedApps: ShackApp[];
  onLaunchApp: (id: ShackApp["id"]) => void;
  sysop: boolean;
  /** Destinations that need attention carry a dot (see useAttention). */
  attention: ReadonlySet<string>;
}) {
  const item = (key: string, icon: IconName, label: string, hint: string, onClick: () => void, cls?: string) => (
    <Button
      key={key}
      className={`${props.active === key ? "on" : ""}${cls ? " " + cls : ""}`}
      onClick={onClick}
      hint={hint}
      aria-current={props.active === key ? "page" : undefined}
      aria-describedby={props.attention.has(key) ? "rail-attn" : undefined}
      data-tour={key === "nearby" ? "nearby" : undefined}
    >
      <Icon name={icon} size={21} />
      {props.attention.has(key) && <span className="nav-dot" aria-hidden="true" />}
      <span>{label}</span>
    </Button>
  );
  const core = (section: NavItem["section"]) =>
    NAV_ITEMS.filter((i) => i.section === section && (!i.sysop || props.sysop)).map((i) =>
      item(i.key, i.icon, i.label, i.hint, () => props.onNav(i.key)),
    );
  // the destinations and the pinned apps scroll when the window is too short for them all; the bottom group (You,
  // Offline, Settings, Admin, Manual) stays in view, so the rail is never taller than the shell
  return (
    <nav className="rail" aria-label="Primary">
      <div className="rail-scroll">
        {core("top")}
        {props.pinnedApps.length > 0 && <span className="rail-div" aria-hidden="true" />}
        {props.pinnedApps.map((app) =>
          item(app.id, app.icon, app.label, app.blurb, () => props.onLaunchApp(app.id), "rail-pinned"),
        )}
      </div>
      <div className="rail-bottom">
        {core("bottom")}
        {NAV_LINKS.map((l) => (
          <Hint key={l.key} text={l.hint}>
            <a className="rail-link" href={l.href} target="_blank" rel="noopener">
              <Icon name={l.icon} size={21} />
              <span>{l.label}</span>
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </Hint>
        ))}
      </div>
      {/* the words of an attention dot, outside the buttons so they describe one without joining its name */}
      <span id="rail-attn" className="sr-only">
        needs attention
      </span>
    </nav>
  );
}
