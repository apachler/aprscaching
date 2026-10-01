# Design review — October 2026

A dated record of the design and accessibility review of the web app. It is out of the manual's nav. The fixes
are tracked per finding below; later phases append their resolution in the **Resolution** column.

## How it was reviewed

- **Rendering:** `node apps/web/test/visual/run.mjs` renders 27 surfaces of the real app against the demo
  fixtures (`apps/web/src/demo/fixtures.ts`, the same data as `/?demo=app`):
  - in the dark, light and Phosphor themes;
  - at 390×844 (phone) and 1280×800 (desktop);
  - with the locale `en-US`, the time zone `Europe/Vienna` and a fixed clock;
  - with every third-party request refused, so the map draws its offline graticule.
  
  Screenshots and the HTML index go to `apps/web/test/visual/out/` (regenerate; not committed). A finding's
  evidence names its screenshot as `<surface>-<theme>-<view>`.
- **axe-core** (WCAG 2.0, 2.1 and 2.2 A/AA tags) runs on every render; `out/axe.json` holds the results.
- **Keyboard:** `--keyboard` tabs through the map, Nearby, Settings and the landing page. It records each stop's
  name, whether a focus indicator is drawn, and whether the stop is on screen (`out/keyboard.json`).
- **Contrast:** `apps/web/test/contrast.test.ts` measures the tokens' declared foreground/background pairs in
  every theme. It resolves `var()`, OKLCH and `color-mix()` itself, so it needs no browser. Pairs that fail
  today are listed as known failures, and the test fails as soon as one of them passes, so the list only
  shrinks.
- **Screen reader:** **not run.** NVDA and VoiceOver are not available in this environment. The spot check on
  the map home, Nearby, cache detail, log a find and Settings is open. axe's name, role and value rules stand
  in for it, and they are not a substitute.

Severity:
- **blocker:** someone cannot complete a task;
- **major:** a WCAG 2.2 AA failure, or a task that is hard;
- **minor:** friction;
- **polish:** looks.

The work item is the handover item that fixes it.

## Baseline in numbers

| Measure | Value |
|---|---|
| Surfaces × themes × sizes rendered | 27 × 3 × 2, 159 renders (search is desktop-only: the top bar has no search below 960 px) |
| axe serious/critical rules failing | 5: `target-size` (62 renders), `color-contrast` (62), `scrollable-region-focusable` (6), `aria-required-children` (6), `list` (6) |
| Contrast pairs failing (of 24 per theme) | dark 1 · light 17 · Phosphor 0 |
| Raw `<button>` outside `ui/` vs the `Button` primitive | 193 vs 75 |
| Inline `style={{…}}` | 10 (DetailPanel 2, NearbyPanel 3, NavigateCache, RemoteCachePanel, PacketTerminal, ToolPanels 2) |
| Icon systems | `Icon` (SVG stroke) 19 uses · `Ico` (emoji in Modern, CP437 in Phosphor) 42 uses |
| Type / spacing / radius / elevation tokens | 23 font sizes (with half steps) · 15 spacing steps · 17 radii · 13 elevations; named by size, not role |
| Colour literals outside `tokens.css` | `offlineBasemap.ts` 15, `MapTools.tsx` 7, `brand.ts` 7, `TrackReplay.tsx` 5, `MeshcomLinks.tsx` 2, `OfflinePanel.tsx` 1 |

## Findings

### Across the app

| ID | Sev. | Finding | Evidence | Work item | Resolution |
|---|---|---|---|---|---|
| R-01 | blocker | There is no light theme to choose. `Theme` is `modern \| phosphor`; `normalizeTheme` maps dark, light and auto to Modern. The rules require dark *and* light (ui-ux §7). | `format.ts` | DSN-06 || Appearance: Auto · Light · Dark · Phosphor, Dark by default (Phase 3). |
| R-02 | major | In light, 17 token pairs fail contrast:<br>• accent as text, and white on the green button: 2.28:1<br>• top-bar text: 3.87:1<br>• tier, status and found/DNF badges: 1.7–2.7:1<br>• tier chip letters: 2–2.5:1<br>• secondary text on raised controls and the rail: 4.3–4.4:1 | contrast test; `*-light-*` | DSN-07 || Fixed: `--accent-text`, `--*-text` hue roles, a deeper light top bar, dark ink on the green fill and on tier chips; 0 failing pairs (Phase 3). |
| R-03 | major | In dark, the DNF badge is 3.98:1. axe also flags `.typechip`, `.danger` and small `.mono` text on some surfaces. | contrast test; `detail-dark-*`, `settings-dark-*` | DSN-07 || Fixed: `--bad-text` and the hue roles; the type chip mixes its hue toward the ink (Phase 3). |
| R-04 | major | In light, the map's locate button is invisible: its glyph uses `--ink-tier`, which is white in light, on MapLibre's white control. | `map-light-*` | DSN-07 || Fixed: `--map-control-ink` on MapLibre's white stack (Phase 3). |
| R-05 | major | The scales sprawl, and are named by size rather than role (`--fs-md-up`, `--r-7`, `--elev-6`), so nobody can tell which step a heading or a card should use. | `tokens.css` | DSN-04a || Fixed: role scales rolled out, size-named steps removed (Phases 2–3). |
| R-06 | major | Two icon systems. The phone tab bar and panel titles use emoji in Modern (🗺 📍 ⚡ 👤, 📡 Shack, 📻 Packet terminal, ✉ Messages, ⚙ Settings), beside SVG line icons in the rail and buttons. | `map-dark-phone`, `shack-*`, `terminal-*` | DSN-08 (G3) || Fixed: one line-icon set (`Icon`, 17 new glyphs), CP437 in Phosphor through the same component; `Ico` removed (Phase 4). |
| R-07 | major | Primitives are bypassed: 193 raw buttons and 10 inline styles. Tabs and segments are styled differently in the BBS (filled pills), the terminal (outlined chips) and Nearby (boxed buttons). | code counts; `bbs-*`, `nearby-*` | DSN-08 || Fixed: every button outside `ui/` is `Button` (8 variants, tested); `Segmented`, `Tabs` and `ChipToggle` primitives; the colour inline styles are `data-ctype` + `--type-*` tokens; the six left pass data (bearing, percentages) as custom properties (Phase 4). |
| R-08 | major | A render error in one panel takes down the whole app. There is only one `ErrorBoundary`, at the root. Seen when the BBS met an unexpected response: "The app stopped with an error". | `bbs-*` (first run) | DSN-09 (local fix) || Fixed: every `Panel` has its own error boundary; a failing panel says so and offers to try again, the rest keeps working (Phase 5). |
| R-09 | minor | `theme-color` is fixed at `#2D8BAB` in every theme, so the browser chrome stays blue in Phosphor and in dark. | `index.html` | DSN-06 || Fixed: one `theme-color` per scheme, set from the top bar of an explicit theme (Phase 3). |
| R-10 | minor | Map colours are literals that don't follow the theme:<br>• MapTools ring and measure lines;<br>• the track replay;<br>• the offline graticule (light under dark and Phosphor). | code; `*-phosphor-*` | DSN-11 || Fixed: the overlays (grid, rings, ruler, arc, night shade, tracks, a pack's outline, MeshCom links) and the offline graticule are `--map-*` tokens, read as hex at paint time and repainted on a theme change (Phase 6). |
| R-11 | major | In Phosphor, MapLibre's control stack (zoom, locate) stays bright white, and pins keep the Modern hues. | `map-phosphor-*`, `settings-phosphor-desktop` | DSN-11 || Fixed: MapLibre's controls and attribution take the terminal's colours in Phosphor; pins and overlays use the Phosphor ramp (Phase 6). |

### Accessibility (WCAG 2.2 AA)

| ID | Sev. | Finding | Evidence | Work item | Resolution |
|---|---|---|---|---|---|
| R-12 | major | **2.5.8 Target size** fails on 62 renders:<br>• the Shack launcher's pin buttons;<br>• the terminal's channel close `.pt-x`;<br>• `<summary>` disclosures in Settings and the cache detail;<br>• disclosure buttons (`button[aria-controls]`). | axe `target-size` | DSN-10 | |
| R-13 | major | **2.4.7 Focus visible:** the top-bar search and the Settings search remove the outline (`outline: none`). The only cue is the wrapper's border going from 18 % to 40 % of the chrome ink. | keyboard walk: map stop 2, settings stop 2 | DSN-10 || Fixed: both search fields draw a 2px ring around the whole field (Phase 5). |
| R-14 | major | **2.4.3 / 2.4.11:** cache pins outside the visible map stay in the tab order. Keyboard focus lands on markers nobody can see (map stops 21 and 23). | keyboard walk | DSN-10 || Fixed: only pins inside the view are focusable, re-checked after every move (Phase 5). |
| R-15 | major | **2.1.1:** the landing page's terminal card is a scrollable region that cannot get keyboard focus. | axe `scrollable-region-focusable` on `landing-*`, `signin-*` | DSN-12 | |
| R-16 | critical | **4.1.2:** the packet terminal's channel bar has `role="tablist"` without `tab` children. | axe `aria-required-children` on `packet-harness-*` | DSN-08 || Fixed: `Tabs` is a pure tablist (Delete closes a channel, the × is pointer-only) (Phase 4). |
| R-16a | major | **1.3.1:** on a phone, the BBS message list is a `<ul>` with children other than `<li>`. | axe `list` on `bbs-*-phone` | DSN-08 || Fixed: each row is a `Button` inside its `<li>` (Phase 4). |
| R-17 | major | **2.5.7 Dragging:** the map has zoom buttons, but no keyboard pan, and no on-screen way to move without dragging except search (desktop only) and Nearby. Unverified against MapLibre's keyboard handler, which pans with the arrow keys once the canvas has focus. The UI doesn't say so. | — | DSN-10 || Fixed: the map canvas is named with its keys ("arrow keys pan; plus and minus zoom; Nearby lists every cache"); zoom buttons, Nearby and the Hide form's coordinate field are the non-drag ways (Phase 5). |
| R-18 | minor | 2.4.11 (sheets covering focus), 3.2.6 (consistent help), 3.3.7 (redundant entry) and 3.3.8 (accessible authentication) are not yet verified. Passkeys and the email link look compliant; it needs a check. | — | DSN-10 || 2.4.11: panels keep scroll padding clear of the tab bar. 3.2.6: the manual button sits in the top bar on every surface, and Settings → Help & credits repeats it. 3.3.7: no journey asked for the same entry twice. 3.3.8: passkey or email link, no puzzle or transcription (Phase 5). |

### Surfaces

| ID | Sev. | Surface | Finding | Evidence | Work item | Resolution |
|---|---|---|---|---|---|---|
| R-19 | major | Instance admin, operator apps | A `?view=admin` (or node, remote) deep link was dropped: it ran before the operator check answered. | `admin-dark-desktop` (first run) | — | **Fixed in this PR**: the deep link waits for the operator check. |
| R-20 | major | Search | The top bar has search only from 960 px up. A phone finds caches through Nearby, and has no way to search stations or a grid. | `map-*-phone` | G7 proposal || Proposed: `design-ia-proposal-2026-10.md`, Proposal 1 — waiting for the owner (G7). |
| R-21 | major | Phone navigation | The phone tab bar holds Map, Nearby, Hide, Activity and You. It is not obvious how to reach Messages, Ranks, the Shack, Settings and Offline: Settings is under the identity chip, and the Shack under You → Advanced. | `*-phone` | G7 proposal || Proposed: same document, Proposal 2; the walk confirms Messages has no path on a phone — waiting for the owner (G7). |
| R-22 | minor | Packet terminal | Before a TNC is open, the surface is blank below its title. There is no empty state saying what it does, what it needs (Web Serial or BLE, a KISS TNC) or what to press. | `terminal-*` | DSN-09 || Fixed: an empty state says what the terminal is for, what it needs, and offers *Open KISS TNC…* (Phase 5). |
| R-23 | minor | Profile | Badges show their raw ids ("finder-50", "rover-hunter"), with no name or explanation. | `profile-*` | DSN-09 || Fixed: badges show their names, with how each was earned as the tooltip (Phase 5). |
| R-24 | minor | Manual reader | An admonition title keeps its Markdown: `New here? [Start here](start-here.md)`. Links in the light theme use the green accent (2.28:1). | `docs-light-desktop` | DSN-13/14, DSN-07 | |
| R-25 | minor | Landing | The page's sections are:<br>• the "How a find works" cards;<br>• the trust model;<br>• six Shack cards with three small screenshots;<br>• four "An APRS map that forgets" cards;<br>• four "Run it anywhere" tiles;<br>• "Free in full".<br><br>All of them use the same card grid on the same dark band. Issues:<br>• the screenshots are too small to read;<br>• the small green eyebrows and the tier badges fail contrast;<br>• on a phone, the terminal card cuts its lines ("· t…"). | `landing-*` | DSN-12 | |
| R-26 | minor | Nearby | The filter is four boxed buttons ("Up for adoption" wraps onto two lines) rather than the segmented control the rules name for 2–4 modes. | `nearby-*-desktop` | DSN-08 || Fixed: the filter is `Segmented` (chips look); "For adoption" fits on one line (Phase 4). |
| R-27 | polish | Map | Under the dark theme the basemap is light: OpenFreeMap liberty, or the light graticule offline. G9 keeps one basemap for all themes; a dark basemap is in TODO. | `map-dark-*` | DSN-11 (TODO) || Kept by G9: one basemap in every theme; a dark vector basemap is in TODO. The offline graticule follows the theme (Phase 6). |
| R-28 | minor | Tab bar | The active tab's label fails contrast in light (axe `.tabbar > .on span`). | `*-light-phone` | DSN-07 || Fixed: `--chrome-ink-muted` for secondary text on the chrome (Phase 3). |

### Not reached by the harness

These aren't rendered yet; Phase 5 walks them by hand:
- the log form with a queued (offline) log;
- the outbox;
- toasts;
- the confirm dialog;
- the geofence banner;
- offline and error states of each panel;
- the Hide form's validation;
- Instance admin on a phone (no rail; the deep link now works).

## Journeys (Phase 5)

`apps/web/test/visual/journeys.mjs` walks seven tasks with the visible controls, by name, on a phone and a
desktop; `out/journeys/log.txt` lists every step. Results:

| Journey | Phone | Desktop | Friction found, and what happened to it |
|---|---|---|---|
| First visit: landing → Explore → tour → skip | ok | ok | The tour is three steps and skippable; there was no way back to it → *Settings → Help & credits → Take the tour again* |
| Sign in | ok | ok | One field, then Continue; passkey or email link |
| Find nearby → Navigate → Log a find → result | ok | ok | The result names the tier and the distance, but not what the tiers mean → *How finds are verified* opens the glossary; the cache sheet's *Verification* gains *What's this?* |
| Hide a cache | ok | ok | Coordinates and *Use my location* are the non-drag ways to place the pin |
| Settings: search "units" | ok | ok | The search field had no visible focus ring → fixed (R-13) |
| Shack: open → launch the BBS → back | **stuck** | ok | No path from the map on a phone → proposal (R-21) |
| Sysop first hour: Instance admin → Setup | ok | ok | The deep link was dropped before the operator check → fixed (R-19) |

Terms in context: *What's this?* links (`platform/TermHelp.tsx`) open the manual's glossary at the term, so the
app and the manual share one vocabulary. They sit at the cache's verification, the log result, the profile's
corroborations and the Shack introduction.

## The map over every basemap (Phase 6)

With the demo's `&net=1` (real tiles allowed), the map was rendered on the vector basemap, OpenTopoMap and
Sentinel-2 satellite in Dark, Light and Phosphor, with the grid, the range rings and the night shade on. Pins,
rings and controls read on all of them. The check found a bug outside the design work: the map tools, a station's
track and the raster basemaps waited for MapLibre's one-time "load" when the style was busy, and never drew when
they mounted after it (another overlay's new sources keep the style "not loaded" for a moment). They now set up
through `whenStyleReady` (tested), as the MeshCom links already did. The map-tool buttons were also named by
their glyph ("▦"); they now have names.

## Proposals for the owner (G7)

Changes to information architecture or behaviour are collected as one batch with before/after mocks, and wait
for approval: `design-ia-proposal-2026-10.md` — search on every screen size (R-20), one *More* destination on
the phone (R-21), and attention dots on the rail and the More sheet.
