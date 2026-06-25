# Adopted Features — from aprs.fi-class APRS maps, reframed for aprscaching
Decisions from the adoption Q&A: **adopt all twelve.** This spec adapts each to our **cache-first**
product and places it in our stack (web = MapLibre SPA · edge = Worker/D1/R2/Durable Objects ·
ingest box), with milestones, schema, API, and rule compliance. Build against this together with
`.claude/rules/ui-ux.md` and `.claude/rules/css.md`.
> **Clean-room note.** aprs.fi is a closed, proprietary service; we adopt only **generic UX
> patterns and ideas**, implemented from scratch. Do not copy aprs.fi code, tiles, symbols, or
> assets. (The underlying APRS-IS data is open.)
---
## 1. Cluster A — Map & field navigation
| Feature | Cache-first adaptation | Stack | Milestone |
|---|---|---|---|
| **Topo + satellite basemaps** | Outdoor cachers want terrain. Vector base = PMTiles (Protomaps) on R2 (free egress, default); **Topo** layer (OpenTopoMap-style) and **Satellite** layer as opt-in. Layer switcher grouped per ui-ux (extras off by default). | web (MapLibre style switch) · R2 (vector tiles) | M1 base · topo/sat M2 |
| **Distance/bearing + route guidance** | A ruler (distance + bearing between two points) and a **"navigate to cache"** action (bearing/compass in-field + hand off to device maps / OSRM directions). | web (client geo math; external directions link) | M2 |
| **Range rings + grid/locator overlay** | Concentric distance rings around *you* or a *cache* ("how far"), plus the Maidenhead grid + MGRS overlay (already borrowed from APRStac). | web (MapLibre layers) | M2 |
| **Day/night terminator + bearing arc** *(from POTACAT, `docs/20`)* | A day/night terminator overlay, a great-circle **bearing arc** from your home QTH to a selected cache/station, and a home-QTH marker. | web (MapLibre layers; client geo math) | M2 |
| **Save & share map view (permalinks)** | Encode map state (center/zoom/layers/filters/selected cache) in the URL; restore on load; shareable. Deep-link a cache or a curated map. | web (URL state) · edge (optional short-link → `saved_views`) | M1–M2 |
**Tile/cost note:** vector base on R2 = ~free. Topo/satellite raster carries provider egress —
use OpenTopoMap within its usage policy, or a keyed provider (MapTiler Outdoor/Satellite, Esri
World Imagery with attribution); cache where the licence allows. Keep raster layers opt-in to
protect the cost model.
---
## 2. Cluster B — History, replay & info depth
| Feature | Cache-first adaptation | Stack | Milestone |
|---|---|---|---|
| **Track history browse by date** | Browse a station's / **living cache's** past positions by date. Uses the `positions` store; living-cache station tracks get a longer retention than firehose. | edge (D1 query) · web | M3 (living caches M2) |
| **Time-replay playback** | Scrub/play a track at selectable speed. Doubles as a **trust visualization**: watch RF-heard fixes appear, gated by independent IGates — the corroboration made visible. Replay your own approach to confirm a find. | web (animation over fetched history; **MUST honor reduced-motion** per css.md) | M3 |
| **Rich cache + station info pages with graphs** | **Cache detail**: logbook, D/T, hint, finds-over-time, owner. **Station detail** (workbench): telemetry, weather, speed/altitude/course via uPlot. Permalinkable. | web (uPlot) · edge (D1) | cache M2 · station M5 |
| **Raw packet view (workbench only)** | Live/per-station raw TNC2 frames for debugging. **Stays out of the cacher surface** (ui-ux drop list). | web (workbench) · edge (`packets_recent`, hard-TTL) | M5 |
---
## 3. Cluster C — Sharing, alerts & personalization
| Feature | Cache-first adaptation | Stack | Milestone |
|---|---|---|---|
| **Deep-link + embeddable cache-map widget** | A lightweight `/embed` iframe (a cache or an area) for clubs/blogs, plus shareable cache pages — the geocaching "listing page" idea. **QR on a physical cache → its page.** | web (small embed route) · edge | M4 |
| **GPX/KML/ADIF export + public API** | GPX export of caches (for GPS devices) + KML of tracks + **ADIF** export of finds/activations (for standard logbooks — Log4OM/N1MM/DXLab; *from POTACAT, `docs/20`*); a public **read API** (caches in bbox, cache detail, station track) à la the aprs.fi API. | edge (Worker endpoints generate GPX/KML/ADIF/JSON; rate-limited + keys) | GPX M3 · API M3–M4 |
| **Proximity / new-cache / watchlist alerts** | In-field geofence prompt already exists (M2). Add **background** alerts: "new cache published near you," "a cache you watch had a find/DNF," and **"a watched callsign is active/heard/near a cache"** (*watchlist, from POTACAT, `docs/20`*). | web (Service Worker + Push API) · edge (DO/cron dispatch) | M4 |
| **Favorites + search-as-you-type** | Favorite/watch caches; unified autocomplete over **cache code/name + callsign + address/locator**, with recent searches. | web (search UI) · edge (search endpoint; D1 FTS5 + geocoder for addresses) | favorites/search M1 · enrich M2 |
**Push note (decided — `docs/14` ADR-4b):** push is **permission- and PWA-install-gated** (iOS needs
an installed PWA). Non-push users get **in-app alerts + an email digest** — the iOS/no-push fallback
is mandatory, not optional. Push **never** blocks the in-field geofence prompt. Coalesce/throttle and
offer per-topic subscribe/unsubscribe (nearby / new-cache / DNF). Backed by `push_subs` + an
email-digest job.
---
## 4. Synergies with our trust model (why these matter beyond parity)
- **Replay + path/IGate data = corroboration, visualized.** The same history that powers replay
  lets a cache page *show* which independent IGates heard a find — turning Tier A from a badge into
  visible evidence.
- **Permalinks + embeds + QR = how caches are shared** (the geocaching listing-page pattern),
  which the original aprscaching lacked.
- **Topo basemaps + range rings + bearing = the field-navigation loop** a cacher actually needs.
- **Watches + alerts** turn one-off finds into ongoing engagement (new-cache and DNF alerts).
---
## 5. Schema additions (D1)
```sql
-- save/share map views + permalink short-links
CREATE TABLE saved_views (
  slug TEXT PRIMARY KEY, owner_call TEXT, name TEXT,
  state TEXT NOT NULL,            -- JSON: center/zoom/layers/filters/selected
  public INTEGER NOT NULL DEFAULT 0, created_at INTEGER
);
-- public API keys (rate tiers)
CREATE TABLE api_keys (
  key TEXT PRIMARY KEY, owner_call TEXT, scopes TEXT, rate_tier TEXT, created_at INTEGER
);
-- web-push subscriptions for proximity/new-cache/DNF alerts
CREATE TABLE push_subs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, callsign TEXT,
  endpoint TEXT, keys TEXT,       -- JSON (p256dh, auth)
  topics TEXT,                    -- nearby | new_cache | watch_dnf
  created_at INTEGER
);
-- fast text search for cache code/name (geo already via cache_rtree)
CREATE VIRTUAL TABLE cache_fts USING fts5(code, title, content='caches', content_rowid='id');
```
`watches` / `favorites` already exist (0001). Living-cache station positions need a **longer
retention** than firehose — extend the nightly TTL to exempt `station_call`s referenced by active
caches.
---
## 6. Public API surface (read, rate-limited)
```
GET /api/caches?bbox=                      caches in view (exists)
GET /api/cache/:code                       detail + logbook + finds-over-time
GET /api/cache/:code.gpx                    single-cache GPX
GET /api/caches.gpx?bbox=                   area GPX export
GET /api/station/:call                      station info
GET /api/station/:call/track?from=&to=      position history (JSON)
GET /api/station/:call.kml                  track as KML
GET /v/:slug                               resolve a saved/shared map view
GET /embed?cache=:code | ?bbox=             embeddable map (iframe)
```
**Access model (decided — `docs/14` ADR-4a):** read-only and **free**. Anonymous access is
**rate-limited per IP**; **free `api_keys` raise the limits** (recognition model — keys are free,
never paywalled). Cap bbox size, paginate, edge-cache bbox/detail responses, enforce read-only, and
keep CORS open for embeds (CSP-friendly). This honors the cost rules and the ad-free /
recognition-only stance.
---
## 7. Rule compliance (do not regress)
- **ui-ux.md:** every adopted feature adds surface area — so each MUST follow progressive
  disclosure. Layer switcher, filters, alert prefs, and API/key management all go into **grouped,
  toggle-gated, collapsible** sections (§2 of the rule). None of this clutters the cacher's default
  map.
- **css.md:** replay and any animation **MUST** honor `prefers-reduced-motion` and animate only
  `transform`/`opacity` over the map; layer/panel responsiveness via container queries; raster
  layers must not trigger blur-over-map perf traps.
- **Cost:** raster basemaps and long history retention are the two cost levers — keep raster opt-in,
  TTL non-essential history, and exempt only active living-cache tracks from cleanup.
---
## 8. Milestone roll-up
- **M1:** vector basemap + layer switcher · save/share map view (URL state) · favorites + basic
  search.
- **M2:** topo/satellite layers · ruler (distance/bearing) + navigate · range rings + grid/MGRS ·
  cache info page with finds-over-time · search enriched (address/locator).
- **M3:** track history by date · time-replay · GPX/KML export · public read API (v1).
- **M4:** deep-link/embeddable widget + QR · background push alerts (nearby/new-cache/DNF) ·
  API keys.
- **M5:** station telemetry/weather graphs · raw packet view (workbench).
---
## 9. Acceptance (per feature, abbreviated)
- Basemaps: switch vector/topo/satellite; raster layers opt-in; attribution shown.
- Permalink: a shared URL restores center/zoom/layers/selected cache exactly.
- Replay: a living cache's day replays at selectable speed; reduced-motion disables animation.
- Cache page: shows logbook + finds-over-time and is deep-linkable; GPX downloads and imports to a
  GPS.
- Embed: an iframe renders a cache/area map without the app chrome.
- Alerts: a watched cache's new DNF pushes a notification (permission-gated); geofence prompt still
  works without push.
- Search: typing a partial code/callsign/town returns ranked suggestions.
- API: bbox + cache detail endpoints return JSON within rate limits.
