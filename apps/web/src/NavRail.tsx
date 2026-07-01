/**
 * NavRail — the operator nav rail shown beside the map at ≥1024px (the denser workbench context).
 * Real <nav>/<button> with the inline-SVG Icon set. Hidden below the breakpoint (CSS). Core
 * destinations are fixed; workbench apps the user has PINNED render after Bench (see workbench/apps).
 */
import { Icon, type IconName } from "./ui/index.js";
import type { WorkbenchApp } from "./workbench/apps.js";

export function NavRail(props: {
  active: string;
  onMap: () => void; onNearby: () => void; onActivity: () => void; onRanks: () => void;
  onWorkbench: () => void; onProfile: () => void; onSettings: () => void;
  pinnedApps?: WorkbenchApp[]; onLaunchApp?: (id: WorkbenchApp["id"]) => void;
}) {
  const item = (key: string, icon: IconName, label: string, onClick: () => void, cls?: string) => (
    <button className={`${props.active === key ? "on" : ""}${cls ? " " + cls : ""}`} onClick={onClick}
            title={label} aria-current={props.active === key ? "page" : undefined}>
      <Icon name={icon} size={21} /><span>{label}</span>
    </button>
  );
  return (
    <nav className="rail" aria-label="Primary">
      {item("map", "map", "Map", props.onMap)}
      {item("nearby", "locate", "Nearby", props.onNearby)}
      {item("activity", "bench", "Activity", props.onActivity)}
      {item("ranks", "ranks", "Ranks", props.onRanks)}
      {item("workbench", "tools", "Bench", props.onWorkbench)}
      {(props.pinnedApps ?? []).length > 0 && <span className="rail-div" aria-hidden="true" />}
      {(props.pinnedApps ?? []).map((app) => item(app.id, app.icon, app.label, () => props.onLaunchApp?.(app.id), "rail-pinned"))}
      {item("profile", "profile", "You", props.onProfile, "rail-sp")}
      {item("settings", "settings", "Setup", props.onSettings)}
    </nav>
  );
}
