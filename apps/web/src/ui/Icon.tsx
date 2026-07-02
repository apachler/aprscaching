/**
 * Icon — inline-SVG glyphs (no Google Material Symbols / web-font dependency: perf + offline,
 * per css.md). 24-unit stroke icons coloured by `currentColor`; size in px. Grow the map as
 * surfaces need more glyphs. A few markers (navigation arrow, overflow dots) are filled.
 */
import type { CSSProperties } from "react";

export type IconName =
  | "close" | "search" | "settings" | "map" | "bench" | "bbs" | "ranks" | "import" | "profile"
  | "hide" | "log" | "navigation" | "flag" | "summit" | "park" | "castle" | "copy" | "share"
  | "bookmark" | "locate" | "layers" | "plus" | "minus" | "check" | "check-circle" | "bell"
  | "shield-check" | "more" | "chevron" | "alert" | "info" | "near" | "radio" | "filter"
  | "tools" | "decode" | "dial" | "server" | "pin" | "pin-off" | "node" | "message";

const D: Record<IconName, string> = {
  close: "M18 6 6 18 M6 6l12 12",
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
  share: "M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M8.6 13.5l6.8 4 M15.4 6.5l-6.8 4",
  bookmark: "M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z",
  locate: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M12 2v3 M12 19v3 M2 12h3 M19 12h3",
  layers: "M12 2 2 7l10 5 10-5z M2 17l10 5 10-5 M2 12l10 5 10-5",
  plus: "M12 5v14 M5 12h14",
  minus: "M5 12h14",
  check: "M20 6 9 17l-5-5",
  "check-circle": "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M8.5 12l2.5 2.5 4.5-5",
  bell: "M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9z M10.3 21a1.94 1.94 0 0 0 3.4 0",
  "shield-check": "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z M9 12l2 2 4-4",
  more: "",       // rendered as three filled dots
  chevron: "M9 6l6 6-6 6",
  alert: "M12 3 2 20h20z M12 9v5 M12 17h.01",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 11v5 M12 8h.01",
  near: "M3 11l19-9-9 19-2-8-8-2z",
  radio: "M4.9 19.1a10 10 0 0 1 0-14.2 M7.8 16.2a6 6 0 0 1 0-8.4 M16.2 7.8a6 6 0 0 1 0 8.4 M19.1 4.9a10 10 0 0 1 0 14.2 M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  filter: "M3 5h18l-7 8v6l-4 2v-8z",
  tools: "M14 7a4 4 0 0 1 5-5l-3 3 2 2 3-3a4 4 0 0 1-5 5L5 20a2 2 0 1 1-3-3z",
  decode: "M4 6v12 M8 6v12 M12 6v12 M16 6v12 M20 6v12",
  dial: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 12l3.5-3.5 M12 7v1 M17 12h-1 M7 12H6",
  server: "M4 4h16v6H4z M4 14h16v6H4z M7.5 7h.01 M7.5 17h.01",
  pin: "M9 3h6l-1 7 4 3v2h-5v6l-1 2-1-2v-6H5v-2l4-3z",
  "pin-off": "M9 3h6l-1 7 4 3v2h-5v6l-1 2-1-2v-6H5v-2l4-3z M3 3l18 18",
  node: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M12 3v3 M12 18v3 M4 6l3.5 3.5 M20 6l-3.5 3.5 M4 18l3.5-3.5 M20 18l-3.5-3.5",
  message: "M4 4h16v16H4z M4 7l8 6 8-6",
};

const FILLED = new Set<IconName>(["navigation", "near"]);

export function Icon(props: { name: IconName; size?: number; className?: string; title?: string; style?: CSSProperties }) {
  const s = props.size ?? 18;
  const common = { width: s, height: s, viewBox: "0 0 24 24", className: props.className, style: props.style,
    "aria-hidden": props.title ? undefined : true, role: props.title ? "img" : undefined };
  if (props.name === "more") {
    return (
      <svg {...common} fill="currentColor" stroke="none">
        {props.title && <title>{props.title}</title>}
        <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
      </svg>
    );
  }
  const filled = FILLED.has(props.name);
  return (
    <svg {...common} fill={filled ? "currentColor" : "none"} stroke={filled ? "none" : "currentColor"}
         strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      {props.title && <title>{props.title}</title>}
      <path d={D[props.name]} />
    </svg>
  );
}
