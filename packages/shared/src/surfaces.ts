/**
 * surfaces.ts — the canonical map of the app's pages/tools (the single source of truth for the
 * gateway's standalone `/sitemap` page, `/sitemap.xml` + `/api/sitemap`, and any dynamic tooling
 * such as the teaser tour). Add a surface here once and every consumer picks it up.
 *
 * The app is a single-page map workbench: most surfaces are overlay panels, not separate documents,
 * so they deep-link via a `?view=<key>` query param (the map position lives in MapLibre's `#z/lat/lon`
 * hash, kept separate on purpose). `view: null` is the map itself (the app root `/`).
 */

export type SurfaceGroup = "Caching" | "Community" | "Workbench" | "Account";

export interface Surface {
  /** stable id — also the panel key in the web app and the `?view=` deep-link value */
  key: string;
  /** `?view=` value for deep-linking; null = the map (served at `/`) */
  view: string | null;
  /** short nav label */
  label: string;
  /** full page title / teaser caption */
  title: string;
  /** one-line description (site map row + sitemap.xml comment) */
  summary: string;
  group: SurfaceGroup;
  /** public = browsable signed-out (Explore); account = needs a callsign/account */
  access: "public" | "account";
  /** include in sitemap.xml (public, linkable browse surfaces) */
  indexable: boolean;
}

export const SURFACES: Surface[] = [
  { key: "map", view: null, label: "Map", title: "Live cache map", group: "Caching", access: "public", indexable: true,
    summary: "Browse caches and live APRS stations on the map." },
  { key: "nearby", view: "nearby", label: "Nearby", title: "Nearby caches", group: "Caching", access: "public", indexable: true,
    summary: "Caches and stations closest to you, sorted by distance." },
  { key: "filter", view: "filter", label: "Search & filter", title: "Search & filter", group: "Caching", access: "public", indexable: true,
    summary: "Search by callsign, cache id or grid; filter by type and trust tier." },
  { key: "hide", view: "hide", label: "Hide a cache", title: "Hide a cache", group: "Caching", access: "account", indexable: false,
    summary: "Place a new cache for others to find." },

  { key: "activity", view: "activity", label: "Activity", title: "Activity feed", group: "Community", access: "public", indexable: true,
    summary: "Recent finds, hides and DNFs across the network." },
  { key: "ranks", view: "ranks", label: "Leaderboard", title: "Leaderboard", group: "Community", access: "public", indexable: true,
    summary: "Top finders and hiders, ranked by callsign and profile." },
  { key: "messages", view: "messages", label: "Messages", title: "APRS messages", group: "Community", access: "public", indexable: false,
    summary: "Live APRS text messages — a first-class inbox, separate from BBS mail." },

  { key: "workbench", view: "workbench", label: "Workbench", title: "Workbench — APRS apps", group: "Workbench", access: "public", indexable: true,
    summary: "App launcher for the operator tools — packet terminal, BBS, decoder, NET/ROM node, plugins, rig & remote control." },
  { key: "bbs", view: "bbs", label: "BBS", title: "BBS — store & forward mail", group: "Workbench", access: "account", indexable: false,
    summary: "APRS store-and-forward mail and bulletins." },

  { key: "profile", view: "profile", label: "You", title: "Your profile", group: "Account", access: "account", indexable: false,
    summary: "Your finds, points, badges and identity." },
  { key: "settings", view: "settings", label: "Settings", title: "Settings", group: "Account", access: "account", indexable: false,
    summary: "Units, basemap, notifications and account." },
  // NB: the site map is intentionally NOT a surface here — it is a standalone page (gateway /sitemap,
  // linked from the landing footer), not an in-app panel. It lists these surfaces; it isn't one.
];

export const SURFACE_GROUPS: SurfaceGroup[] = ["Caching", "Community", "Workbench", "Account"];

export const surfaceByKey = (key: string): Surface | null => SURFACES.find((s) => s.key === key) ?? null;
export const surfaceByView = (view: string): Surface | null => SURFACES.find((s) => s.view === view) ?? null;

/** Platform RSS feeds — advertised in /api/sitemap and the /sitemap page. */
export interface FeedDef { key: string; path: string; title: string; summary: string }

export const FEEDS: FeedDef[] = [
  { key: "activity", path: "/feeds/activity.xml", title: "Activity", summary: "Recent finds, hides and DNFs across the network." },
  { key: "caches", path: "/feeds/caches.xml", title: "New caches", summary: "Recently published public caches." },
  { key: "bulletins", path: "/feeds/bulletins.xml", title: "Bulletins", summary: "Public APRS bulletins." },
  { key: "leaderboard", path: "/feeds/leaderboard.xml", title: "Leaderboard", summary: "Top finders, ranked by verified finds." },
];

/** Per-user RSS feed path (callsign uppercased): finds, badge awards and scoring. */
export const userFeedPath = (callsign: string): string => `/feeds/u/${encodeURIComponent(callsign.toUpperCase())}.xml`;
