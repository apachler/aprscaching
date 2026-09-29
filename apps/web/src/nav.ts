// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * nav.ts — what the platform shows beside the map, and how navigation reaches it.
 *
 * One `View` value describes the open left-dock surface, so at most one is open at a time (ui-ux §5):
 * opening one cannot leave another open. The right-dock cache detail is separate state, since it
 * deliberately coexists with a left panel on wide screens.
 *
 * `NAV_ITEMS` is the single table of top-level destinations: the rail draws it, the mobile tab bar
 * draws its `tab` subset, and both derive their active item from the open view with `activeKey`.
 * `?view=` query strings (the shared SURFACES deep links, plus admin, the Shack apps and a station)
 * map to views through `viewQuery` / `viewFromQuery`; the map position stays in MapLibre's hash.
 */
import type { IconName } from "./ui/Icon.js";
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
  | "docs"
  | "signin";

export type View =
  | { kind: "map" }
  | { kind: "panel"; key: PanelKey }
  | { kind: "app"; id: ShackAppId }
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
  "docs",
  "signin",
];
const isPanelKey = (k: string): k is PanelKey => (PANEL_KEYS as readonly string[]).includes(k);
const isAppId = (k: string): k is ShackAppId => SHACK_APPS.some((a) => a.id === k);

export interface NavItem {
  /** The panel key this item opens ("map" closes everything). */
  key: "map" | PanelKey;
  label: string;
  icon: IconName;
  /** Rail section: pinned Shack apps render between "top" and "bottom". */
  section: "top" | "bottom";
  /** Also a mobile tab: its Modern glyph and its Phosphor (CP437/ASCII) glyph. */
  tab?: { glyph: string; cog: string };
  /** Shown only to this instance's operator. */
  sysop?: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { key: "map", label: "Map", icon: "map", section: "top", tab: { glyph: "🗺", cog: "▦" } },
  { key: "nearby", label: "Nearby", icon: "locate", section: "top", tab: { glyph: "📍", cog: "@" } },
  { key: "activity", label: "Activity", icon: "bench", section: "top", tab: { glyph: "⚡", cog: "↯" } },
  { key: "messages", label: "Messages", icon: "message", section: "top" },
  { key: "ranks", label: "Ranks", icon: "ranks", section: "top" },
  { key: "shack", label: "Shack", icon: "tools", section: "top" },
  { key: "profile", label: "You", icon: "profile", section: "bottom", tab: { glyph: "👤", cog: "☺" } },
  { key: "settings", label: "Settings", icon: "settings", section: "bottom" },
  { key: "admin", label: "Admin", icon: "shield-check", section: "bottom", sysop: true },
];
export const TAB_ITEMS: readonly NavItem[] = NAV_ITEMS.filter((i) => i.tab);

/** The view a nav key opens. */
export const viewOf = (key: NavItem["key"]): View => (key === "map" ? MAP : panel(key));

/**
 * Which of `keys` (the items a nav bar shows) the open view lights. A launched Shack app lights its
 * pinned rail item, else the Shack launcher; anything without an item of its own lights the map.
 */
export function activeKey(view: View, keys: ReadonlySet<string>): string {
  const k = view.kind === "panel" ? view.key : view.kind === "app" ? view.id : "map";
  if (keys.has(k)) return k;
  if (view.kind === "app" && keys.has("shack")) return "shack";
  return "map";
}

export function sameView(a: View, b: View): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "panel") return a.key === (b as typeof a).key;
  if (a.kind === "app") return a.id === (b as typeof a).id;
  if (a.kind === "station") return a.call === (b as typeof a).call;
  return true;
}

/** `search` with the view's `?view=` parameters in place of any it carried; other parameters stay. */
export function viewQuery(view: View, search: string): string {
  const p = new URLSearchParams(search);
  for (const k of ["view", "call", "doc"]) p.delete(k);
  if (view.kind === "panel") p.set("view", view.key);
  else if (view.kind === "app") p.set("view", view.id);
  else if (view.kind === "station") {
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
  if (isAppId(v)) return { kind: "app", id: v };
  const call = p.get("call");
  if (v === "station" && call) return { kind: "station", call };
  return null;
}

/** The slice of `window` the history sync uses. */
export interface HistoryHost {
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
        history.back();
      } else if (here() !== url) history.replaceState(history.state, "", url);
    } else if (open) push(url);
    else if (here() !== url) history.replaceState(history.state, "", url);
  };

  const onPopState = () => {
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
