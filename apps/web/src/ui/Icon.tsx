// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Icon — the app's one icon set (docs/contribute/design/design-language.md): inline-SVG line icons on a 24-unit grid,
 * stroke 2, coloured by `currentColor`, size in px. No icon font, so they work offline and cost no request.
 * A few markers (navigation arrow, overflow dots) are filled. In the Phosphor theme an icon given a `cp437`
 * glyph shows that glyph instead (an empty string drops it), so the terminal look stays text through the same
 * component; without one, Phosphor shows the line icon.
 */
import type { CSSProperties } from "react";
import { useTheme } from "../format.js";

export type IconName =
  | "close"
  | "search"
  | "settings"
  | "map"
  | "bench"
  | "bbs"
  | "ranks"
  | "import"
  | "profile"
  | "hide"
  | "log"
  | "navigation"
  | "flag"
  | "summit"
  | "park"
  | "castle"
  | "copy"
  | "share"
  | "bookmark"
  | "locate"
  | "layers"
  | "plus"
  | "minus"
  | "check"
  | "check-circle"
  | "bell"
  | "shield-check"
  | "more"
  | "chevron"
  | "alert"
  | "info"
  | "near"
  | "radio"
  | "filter"
  | "tools"
  | "decode"
  | "dial"
  | "server"
  | "pin"
  | "pin-off"
  | "node"
  | "message"
  | "offline"
  | "edit"
  | "thermo"
  | "drop"
  | "wind"
  | "rain"
  | "lock"
  | "signal"
  | "car"
  | "handover"
  | "ruler"
  | "link"
  | "attach"
  | "satellite"
  | "antenna"
  | "trophy"
  | "place"
  | "menu";

const D: Record<IconName, string> = {
  close: "M18 6 6 18 M6 6l12 12",
  menu: "M4 6h16 M4 12h16 M4 18h16",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M21 21l-4.3-4.3",
  settings: "M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 14h6 M9 8h6 M17 16h6",
  map: "M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2z M9 4v14 M15 6v14",
  bench: "M22 12h-4l-3 9L9 3l-3 9H2",
  bbs: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
  ranks: "M3 3v18h18 M7 16v-5 M12 16V8 M17 16v-9",
  import: "M12 3v12 M7 10l5 5 5-5 M5 21h14",
  profile: "M20 21a8 8 0 0 0-16 0 M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  hide: "M12 21s7-6 7-12a7 7 0 0 0-14 0c0 6 7 12 7 12z M9.5 9h5 M12 6.5v5",
  log: "M16 11l2 2 4-4 M11 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0z M3 21v-2a4 4 0 0 1 4-4h4",
  navigation: "M3 11l19-9-9 19-2-8-8-2z",
  flag: "M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z M4 22V15",
  summit: "M3 20h18L13.5 6l-3.5 6-2-3z",
  park: "M12 2 6 11h3l-3 5h12l-3-5h3z M12 16v6",
  castle: "M5 21V8l2 1V6h2v2l2-1 2 1V6h2v3l2-1v13z M11 21v-4h2v4",
  copy: "M9 9h11a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V11a2 2 0 0 1 2-2z M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
  share:
    "M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M8.6 13.5l6.8 4 M15.4 6.5l-6.8 4",
  bookmark: "M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z",
  locate: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M12 2v3 M12 19v3 M2 12h3 M19 12h3",
  layers: "M12 2 2 7l10 5 10-5z M2 17l10 5 10-5 M2 12l10 5 10-5",
  plus: "M12 5v14 M5 12h14",
  minus: "M5 12h14",
  check: "M20 6 9 17l-5-5",
  "check-circle": "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M8.5 12l2.5 2.5 4.5-5",
  bell: "M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9z M10.3 21a1.94 1.94 0 0 0 3.4 0",
  "shield-check": "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z M9 12l2 2 4-4",
  more: "", // rendered as three filled dots
  chevron: "M9 6l6 6-6 6",
  alert: "M12 3 2 20h20z M12 9v5 M12 17h.01",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 11v5 M12 8h.01",
  near: "M3 11l19-9-9 19-2-8-8-2z",
  radio:
    "M4.9 19.1a10 10 0 0 1 0-14.2 M7.8 16.2a6 6 0 0 1 0-8.4 M16.2 7.8a6 6 0 0 1 0 8.4 M19.1 4.9a10 10 0 0 1 0 14.2 M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  filter: "M3 5h18l-7 8v6l-4 2v-8z",
  tools: "M14 7a4 4 0 0 1 5-5l-3 3 2 2 3-3a4 4 0 0 1-5 5L5 20a2 2 0 1 1-3-3z",
  decode: "M4 6v12 M8 6v12 M12 6v12 M16 6v12 M20 6v12",
  dial: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 12l3.5-3.5 M12 7v1 M17 12h-1 M7 12H6",
  server: "M4 4h16v6H4z M4 14h16v6H4z M7.5 7h.01 M7.5 17h.01",
  pin: "M9 3h6l-1 7 4 3v2h-5v6l-1 2-1-2v-6H5v-2l4-3z",
  "pin-off": "M9 3h6l-1 7 4 3v2h-5v6l-1 2-1-2v-6H5v-2l4-3z M3 3l18 18",
  node: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M12 3v3 M12 18v3 M4 6l3.5 3.5 M20 6l-3.5 3.5 M4 18l3.5-3.5 M20 18l-3.5-3.5",
  message: "M4 4h16v16H4z M4 7l8 6 8-6",
  offline:
    "M2 2l20 20 M8.5 16.4a5 5 0 0 1 7 0 M5 12.9a10 10 0 0 1 5-2.8 M19 12.9a10 10 0 0 0-2.6-1.8 M2 8.8a15 15 0 0 1 4.6-2.8 M22 8.8a15 15 0 0 0-11-3.8 M12 20h.01",
  edit: "M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  thermo: "M14 14.8V4a2 2 0 0 0-4 0v10.8a4 4 0 1 0 4 0z",
  drop: "M12 2.7l5.7 5.7a8 8 0 1 1-11.4 0z",
  wind: "M17.7 7.7A2.5 2.5 0 1 1 19.5 12H2 M9.6 4.6A2 2 0 1 1 11 8H2 M12.6 19.4A2 2 0 1 0 14 16H2",
  rain: "M20 16.6A5 5 0 0 0 18 7h-1.3A8 8 0 1 0 4 15.3 M16 14v6 M8 14v6 M12 16v6",
  lock: "M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4",
  signal: "M2 20h.01 M7 20v-4 M12 20v-8 M17 20V8 M22 20V4",
  car: "M3 17v-5l2-5h14l2 5v5z M3 12h18 M7 17v2 M17 17v2 M7 14.5h.01 M17 14.5h.01",
  handover: "M4 8h14l-4-4 M20 16H6l4 4",
  ruler: "M3 17 17 3l4 4L7 21z M7 13l2 2 M10 10l2 2 M13 7l2 2",
  link: "M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7 M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7",
  attach: "M21 11.5l-8.6 8.6a5 5 0 0 1-7-7l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l8-8",
  satellite: "M13 7 9 3 5 7l4 4 M17 11l4 4-4 4-4-4 M8 12l4 4 6-6-4-4z M9 21a6 6 0 0 0-6-6",
  antenna: "M12 12v9 M8 21h8 M9.5 9a2.5 2.5 0 1 1 5 0 M6.5 6.5a7.5 7.5 0 0 1 11 0 M12 9.5h.01",
  trophy: "M8 21h8 M12 16v5 M7 4h10v5a5 5 0 0 1-10 0z M17 6h3v1a3 3 0 0 1-3 3 M7 6H4v1a3 3 0 0 0 3 3",
  place: "M12 21s7-6 7-12a7 7 0 0 0-14 0c0 6 7 12 7 12z M12 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
};

/** Every icon, in the order they are defined (the design harness shows them all). */
export const ICON_NAMES = Object.keys(D) as IconName[];

const FILLED = new Set<IconName>(["navigation", "near"]);

export function Icon(props: {
  name: IconName;
  size?: number;
  className?: string;
  title?: string;
  style?: CSSProperties;
  /** the glyph Phosphor shows instead ("" shows nothing) */
  cp437?: string;
}) {
  const phosphor = useTheme() === "phosphor";
  if (phosphor && props.cp437 !== undefined) {
    return props.cp437 ? (
      <span className={["ico", props.className].filter(Boolean).join(" ")} aria-hidden="true">
        {props.cp437}
      </span>
    ) : null;
  }
  const s = props.size ?? 18;
  const common = {
    width: s,
    height: s,
    viewBox: "0 0 24 24",
    className: props.className,
    style: props.style,
    "aria-hidden": props.title ? undefined : true,
    role: props.title ? "img" : undefined,
  };
  if (props.name === "more") {
    return (
      <svg {...common} fill="currentColor" stroke="none">
        {props.title && <title>{props.title}</title>}
        <circle cx="5" cy="12" r="1.6" />
        <circle cx="12" cy="12" r="1.6" />
        <circle cx="19" cy="12" r="1.6" />
      </svg>
    );
  }
  const filled = FILLED.has(props.name);
  return (
    <svg
      {...common}
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {props.title && <title>{props.title}</title>}
      <path d={D[props.name]} />
    </svg>
  );
}
