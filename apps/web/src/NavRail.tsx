// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * NavRail — the nav rail beside the map from 681px up, where the phone's tab bar ends: compact, icons only, up to
 * 1023px, and with each icon's label from 1024px. In the compact rail the label stays the item's accessible name
 * and shows at the head of its hint, on hover and keyboard focus (CSS). Real <nav>/<button> with the inline-SVG
 * Icon set. The core destinations come from the nav table (nav.ts); the Shack apps and tools the user has PINNED
 * render after Shack.
 * The Admin item shows only to this instance's operator (and every admin write is gated server-side). The
 * links outside the app (the manual) close the rail, opening in a new tab.
 */
import { Icon, type IconName, Button, Hint } from "./ui/index.js";
import { NAV_ITEMS, NAV_LINKS, type NavItem, type PinnedItem, type View } from "./nav.js";

export function NavRail(props: {
  /** The lit item's key (see nav.ts activeKey). */
  active: string;
  onNav: (key: NavItem["key"]) => void;
  /** The user's pinned Shack apps and tools, drawn after the top destinations. */
  pinned: PinnedItem[];
  onOpen: (view: View) => void;
  sysop: boolean;
  /** Destinations that need attention carry a dot (see useAttention). */
  attention: ReadonlySet<string>;
}) {
  const item = (key: string, icon: IconName, label: string, hint: string, onClick: () => void, cls?: string) => (
    <Hint key={key} text={hint} title={label}>
      <Button
        className={`${props.active === key ? "on" : ""}${cls ? " " + cls : ""}`}
        onClick={onClick}
        aria-current={props.active === key ? "page" : undefined}
        aria-describedby={props.attention.has(key) ? "rail-attn" : undefined}
        data-tour={key === "nearby" ? "nearby" : undefined}
      >
        <Icon name={icon} size={21} />
        {props.attention.has(key) && <span className="nav-dot" aria-hidden="true" />}
        <span className="rail-label">{label}</span>
      </Button>
    </Hint>
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
        {props.pinned.length > 0 && <span className="rail-div" aria-hidden="true" />}
        {props.pinned.map((p) => item(p.key, p.icon, p.label, p.hint, () => props.onOpen(p.view), "rail-pinned"))}
      </div>
      <div className="rail-bottom">
        {core("bottom")}
        {NAV_LINKS.map((l) => (
          <Hint key={l.key} text={l.hint} title={l.label}>
            <a className="rail-link" href={l.href} target="_blank" rel="noopener">
              <Icon name={l.icon} size={21} />
              <span className="rail-label">{l.label}</span>
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
