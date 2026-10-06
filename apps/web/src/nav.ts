// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * nav.ts — what the platform shows beside the map, and how navigation reaches it.
 *
 * One `View` value describes the open left-dock surface, so at most one is open at a time (ui-ux §5):
 * opening one cannot leave another open. The right-dock cache detail is separate state, since it
 * deliberately coexists with a left panel on wide screens.
 *
 * `NAV_ITEMS` is the single table of top-level destinations: the rail draws it, the mobile tab bar
 * draws its `tab` subset and its More sheet the rest (`MORE_ITEMS`), so the phone reaches every destination the
 * rail has; all of them derive their active item from the open view with `activeKey`. `NAV_LINKS` are the
 * destinations outside the app (the manual), which the rail and the More sheet both end with.
 * `?view=` query strings (the shared SURFACES deep links, plus admin, the Shack apps and a station)
 * map to views through `viewQuery` / `viewFromQuery`; the map position stays in MapLibre's hash. An app's
 * `&tool=` names the tool it opens with (a pinned tool opens Tools this way).
 */
import type { IconName } from "./ui/Icon.js";
import { MANUAL_URL } from "./brand.js";
import { SHACK_APPS, type ShackAppId } from "./shack/apps.js";

export type PanelKey =
  | "nearby"
  | "filter"
  | "hide"
  | "activity"
  | "ranks"
  | "messages"
  | "shack"
  | "profile"
  | "settings"
  | "admin"
  | "signin"
  | "outbox"
  | "offline"
  | "alerts";

export type View =
  | { kind: "map" }
  | { kind: "panel"; key: PanelKey }
  | { kind: "app"; id: ShackAppId; tool?: string }
  | { kind: "station"; call: string };

export const MAP: View = { kind: "map" };
export const panel = (key: PanelKey): View => ({ kind: "panel", key });

const PANEL_KEYS: readonly PanelKey[] = [
  "nearby",
  "filter",
  "hide",
  "activity",
  "ranks",
  "messages",
  "shack",
  "profile",
  "settings",
  "admin",
  "signin",
  "outbox",
  "offline",
  "alerts",
];
const isPanelKey = (k: string): k is PanelKey => (PANEL_KEYS as readonly string[]).includes(k);
const isAppId = (k: string): k is ShackAppId => SHACK_APPS.some((a) => a.id === k);

export interface NavItem {
  /** The panel key this item opens ("map" closes everything). */
  key: "map" | PanelKey;
  label: string;
  icon: IconName;
  /** One line on what the destination holds, for its hint. */
  hint: string;
  /** Rail section: pinned Shack apps render between "top" and "bottom". */
  section: "top" | "bottom";
  /** Also a mobile tab, with the glyph the Phosphor theme shows in place of its icon. */
  tab?: { cog: string };
  /** Shown only to this instance's operator. */
  sysop?: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    key: "map",
    label: "Map",
    icon: "map",
    hint: "Caches, stations and spots on the live map",
    section: "top",
    tab: { cog: "▦" },
  },
  {
    key: "nearby",
    label: "Nearby",
    icon: "locate",
    hint: "The caches closest to you or to the map's centre",
    section: "top",
    tab: { cog: "@" },
  },
  {
    key: "activity",
    label: "Activity",
    icon: "bench",
    hint: "Recent finds, new caches and what stations heard",
    section: "top",
    tab: { cog: "↯" },
  },
  {
    key: "messages",
    label: "Messages",
    icon: "message",
    hint: "APRS messages to and from your callsign",
    section: "top",
  },
  {
    key: "ranks",
    label: "Ranks",
    icon: "ranks",
    hint: "Leaderboards of finders and hiders by callsign",
    section: "top",
  },
  {
    key: "shack",
    label: "Shack",
    icon: "tools",
    hint: "Radio apps: packet terminal, BBS, rig control and tools such as the packet decoder",
    section: "top",
  },
  {
    key: "profile",
    label: "You",
    icon: "profile",
    hint: "Your profile, finds, hides and callsigns",
    section: "bottom",
  },
  {
    key: "offline",
    label: "Offline",
    icon: "import",
    hint: "Save areas and logs for use without signal",
    section: "bottom",
  },
  {
    key: "settings",
    label: "Settings",
    icon: "settings",
    hint: "Account, appearance, your radio, notifications and your data",
    section: "bottom",
  },
  {
    key: "admin",
    label: "Admin",
    icon: "shield-check",
    hint: "Settings for the whole instance, for its operator only",
    section: "bottom",
    sysop: true,
  },
];
export const TAB_ITEMS: readonly NavItem[] = NAV_ITEMS.filter((i) => i.tab);

/**
 * The phone's More sheet: every rail destination that is not a tab, in the rail's order with You first and Admin
 * last for the operator.
 */
export const MORE_ITEMS: readonly NavItem[] = [
  ...NAV_ITEMS.filter((i) => i.key === "profile"),
  ...NAV_ITEMS.filter((i) => !i.tab && i.key !== "profile" && !i.sysop),
  ...NAV_ITEMS.filter((i) => i.sysop),
];

/** A pinned Shack app or tool as the rail and the phone's More sheet draw it: its pin id is its key. */
export interface PinnedItem {
  key: string;
  icon: IconName;
  label: string;
  hint: string;
  view: View;
}

/** A destination outside the app, opened in a new tab. */
interface NavLink {
  key: string;
  label: string;
  icon: IconName;
  href: string;
  /** What is behind the link, for its hint. */
  hint: string;
}
export const NAV_LINKS: readonly NavLink[] = [
  { key: "manual", label: "Manual", icon: "book", href: MANUAL_URL, hint: "The user manual, on its own site" },
];
/** Whether the open view is one the More sheet reaches, so the More tab lights for it. */
export function inMore(view: View): boolean {
  const k = view.kind === "panel" ? view.key : view.kind === "app" ? "shack" : null;
  return !!k && MORE_ITEMS.some((i) => i.key === k);
}

/** The view a nav key opens. */
export const viewOf = (key: NavItem["key"]): View => (key === "map" ? MAP : panel(key));

/**
 * Which of `keys` (the items a nav bar shows) the open view lights. A tool opened in Tools lights its pin
 * (`tool:<name>`); a launched Shack app lights its pinned rail item, else the Shack launcher; anything without an
 * item of its own lights the map.
 */
export function activeKey(view: View, keys: ReadonlySet<string>): string {
  if (view.kind === "app" && view.tool && keys.has(`tool:${view.tool}`)) return `tool:${view.tool}`;
  const k = view.kind === "panel" ? view.key : view.kind === "app" ? view.id : "map";
  if (keys.has(k)) return k;
  if (view.kind === "app" && keys.has("shack")) return "shack";
  return "map";
}

export function sameView(a: View, b: View): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "panel") return a.key === (b as typeof a).key;
  if (a.kind === "app") return a.id === (b as typeof a).id && a.tool === (b as typeof a).tool;
  if (a.kind === "station") return a.call === (b as typeof a).call;
  return true;
}

/** `search` with the view's `?view=` parameters in place of any it carried; other parameters stay. */
export function viewQuery(view: View, search: string): string {
  const p = new URLSearchParams(search);
  // `cache` is a one-shot share link (cacheFromQuery): once the platform has read it, it leaves the address
  for (const k of ["view", "call", "tool", "cache"]) p.delete(k);
  if (view.kind === "panel") p.set("view", view.key);
  else if (view.kind === "app") {
    p.set("view", view.id);
    if (view.tool) p.set("tool", view.tool);
  } else if (view.kind === "station") {
    p.set("view", "station");
    p.set("call", view.call);
  }
  const q = p.toString();
  return q ? `?${q}` : "";
}

/** The view a query string deep-links to, or null for the bare map (or an unknown view). */
export function viewFromQuery(search: string): View | null {
  const p = new URLSearchParams(search);
  const v = p.get("view");
  if (!v) return null;
  if (isPanelKey(v)) return panel(v);
  const tool = p.get("tool");
  if (isAppId(v)) return tool ? { kind: "app", id: v, tool } : { kind: "app", id: v };
  const call = p.get("call");
  if (v === "station" && call) return { kind: "station", call };
  return null;
}

/** The slice of `window` the history sync uses. */
interface HistoryHost {
  history: {
    readonly state: unknown;
    pushState(state: unknown, title: string, url: string): void;
    replaceState(state: unknown, title: string, url: string): void;
    back(): void;
  };
  readonly location: { pathname: string; search: string; hash: string };
  addEventListener(type: "popstate", fn: () => void): void;
  removeEventListener(type: "popstate", fn: () => void): void;
}

const MARK = "acsView";
const isOurs = (state: unknown) =>
  !!state && typeof state === "object" && (state as Record<string, unknown>)[MARK] === true;
/**
 * The histories with a close's back() still on its way. It is kept per history, not per instance, so a second
 * instance on the same window (a remount, React's StrictMode running effects twice) never sends a second back(),
 * which would step out of the app.
 */
const backPending = new WeakSet<object>();

/**
 * Keep the browser history in step with the open view, so the back button (Android's included)
 * closes what is open instead of leaving the app.
 *
 * `sync(view, open)` is called after every render: while anything is open there is exactly one
 * pushed entry above a clean map entry, carrying the view's `?view=` (switching views replaces it);
 * closing from the UI pops that entry. A back/forward traversal reports the restored view through
 * `onPop`. `currentHash` returns the map's live `#zoom/lat/lon`: a restored entry carries the hash
 * from when it was left, and it is rewritten before MapLibre reads it so the map does not jump.
 */
export function createViewHistory(
  win: HistoryHost,
  onPop: (view: View) => void,
  currentHash?: () => string | null,
): { sync: (view: View, open: boolean) => void; dispose: () => void } {
  const { history } = win;
  const here = () => win.location.pathname + win.location.search + win.location.hash;
  const urlFor = (view: View) => win.location.pathname + viewQuery(view, win.location.search) + win.location.hash;
  // A UI close has called back(); until its popstate lands, a new open waits in `queued`.
  let popping = false;
  let queued: View | null = null;

  const push = (url: string) => {
    const base = urlFor(MAP);
    if (here() !== base) history.replaceState(history.state, "", base);
    history.pushState({ [MARK]: true }, "", url);
  };

  const sync = (view: View, open: boolean) => {
    if (popping) {
      queued = open ? view : null;
      return;
    }
    const url = urlFor(open ? view : MAP);
    if (isOurs(history.state)) {
      if (!open) {
        popping = true;
        if (!backPending.has(history)) {
          backPending.add(history);
          history.back();
        }
      } else if (here() !== url) history.replaceState(history.state, "", url);
    } else if (open) push(url);
    else if (here() !== url) history.replaceState(history.state, "", url);
  };

  const onPopState = () => {
    backPending.delete(history);
    const hash = currentHash?.();
    if (hash && hash !== win.location.hash)
      history.replaceState(history.state, "", win.location.pathname + win.location.search + hash);
    if (popping) {
      popping = false;
      if (queued) push(urlFor(queued)); // built on the restored base entry's URL
      queued = null;
      return;
    }
    onPop(viewFromQuery(win.location.search) ?? MAP);
  };

  win.addEventListener("popstate", onPopState);
  return { sync, dispose: () => win.removeEventListener("popstate", onPopState) };
}
