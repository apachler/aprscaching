/**
 * NavRail — the operator nav rail shown beside the map at ≥1024px (the denser workbench context,
 * where surfacing Workbench/BBS directly is appropriate; the cacher/mobile keeps them behind
 * Profile). Real <nav>/<button> with the inline-SVG Icon set. Hidden below the breakpoint (CSS).
 */
import { Icon, type IconName } from "./ui/index.js";

export function NavRail(props: {
  active: string;
  onMap: () => void; onNearby: () => void; onActivity: () => void; onRanks: () => void;
  onWorkbench: () => void; onMail: () => void; onProfile: () => void; onSettings: () => void;
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
      {item("workbench", "radio", "Bench", props.onWorkbench)}
      {item("bbs", "bbs", "BBS", props.onMail)}
      {item("profile", "profile", "You", props.onProfile, "rail-sp")}
      {item("settings", "settings", "Setup", props.onSettings)}
    </nav>
  );
}
