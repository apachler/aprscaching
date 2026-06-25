# M8 — Operator UI pass (adopting the design-canvas mockup)

A visual re-architecture toward the "operator console" look from the OE8APR design mockup
(`APRScaching_standalone.html`), **re-expressed through our own tokens / primitives / semantics** —
not a copy of the mockup's inline-styled markup. Governed by `.claude/rules/ui-ux.md` + `css.md`.

## Decisions (locked with the author)
1. **Accent / identity — keep ours.** Green `--accent` stays the **single** primary-action color;
   blue stays chrome. We do **not** adopt the mockup's cyan `#1ebde3` — it sits in APRStac-teal
   territory, which CLAUDE.md + css.md explicitly forbid. (The operator *look* is achieved with
   layout, density, type and the tier chips, not by changing the accent.)
2. **Typography — Fredoka brand + IBM Plex Mono data.** Keep **Fredoka** for brand/headings; add
   **IBM Plex Mono** (OFL, self-hosted `apps/web/public/fonts/IBMPlexMono-{400,500,600}.woff2`) as
   `--font-mono` for all data (callsigns, grids, coordinates, ids, tier letters). Icons are **inline
   SVG** (an `Icon` primitive) — no Google Material Symbols / web-font dependency (perf + offline).
3. **Tier palette — keep ours, adopt the prominent chip.** A=green / B=blue / C=**neutral grey**
   (IS-only is *unverified*, not an error — we keep it neutral, not the mockup's alarm-red; B stays
   blue, not amber, to avoid colliding with `--warn`). Adopt the mockup's **square letter chip**
   (A/B/C) and the explicit **min-verification-tier** display.
4. **Layout — full 3-pane desktop operator.** Desktop: left **nav rail** (Map/Bench/BBS/Ranks/
   Import/Setup) + **Nearby** panel + **map** + **cache-detail** panel, persistent. Mobile keeps the
   bottom tab bar + sheets. The panel↔sheet swap remains a viewport media query; panels remain
   container-query contexts.

## Genuinely additive wins from the mockup (take regardless of styling)
- **Min-verification-tier** surfaced on the cache (chip + one-line reason).
- **Per-log method + device-signed** marker in the logbook (`method: aprs_rf_peer`, ✓ signed).
- **Mobile verification breakdown** at log time ("Heard on RF · qAR via … · Tier A available" /
  "GPS lock ±6 m · in geofence") — makes the trust model legible at the moment of action.
- **Coordinate readout** (Lat/Lon · Maidenhead grid) + **global search** (callsign / id / grid).
  (MGRS from the mockup is deferred — niche; needs a conversion lib.)

## Phases
- **P1 — foundation** (this pass): self-host IBM Plex Mono → `--font-mono`; add operator surface
  tokens (denser dark) in the `@layer tokens` OKLCH system; `Icon` (inline SVG) primitive; upgrade
  `TierBadge` with a square **chip** variant; add `MinTier`, `VerifyPanel`/`VerifyRow`, `Stat`,
  `DTBars` primitives. Apply to the **cache-detail** panel (the showcase) + the **mobile geofence →
  proximity card**.
- **P2 — desktop 3-pane shell** ✅: `.app` is a flex column (top bar + `.shell`); `.shell` is a flex
  row [nav rail · left-dock panels · `.mapwrap` · right-dock detail]. Responsive tiers: **<681px**
  bottom sheets + tab bar (unchanged); **681–1023px** the original top-bar nav + floating right
  drawer (unchanged); **≥1024px** the operator console — `NavRail` (Map/Nearby/Activity/Ranks/Bench/
  BBS/You/Setup, inline-SVG) + side panels dock in-flow, the cache detail docks right and coexists
  with a left panel. MapLibre `resize()` fires on dock open/close.
- **P3 — Nearby cards + top-bar search** ✅: Nearby restyled to operator cache cards (cache-type
  icon tile · name · id·source · D/T pill · distance + compass bearing), All/Caches/Stations
  filter chips, and a live-stations section (heading arrow rotated by course). Top-bar **global
  search** binds to the text filter and, on Enter, flies to a Maidenhead locator or "lat, lon".
  (Per-cache tier dot deferred — `MapCache` doesn't carry `minTrust`; needs a small DTO add. The
  APRS-IS-LIVE rx/min pill is deferred — needs a live ingest-rate feed.)
- **P4 — map coordinate readout** ✅: a frosted Lat/Lon · Maidenhead-grid readout (bottom-left),
  updated on every pan. (Restyling MapLibre's own controls + a Maidenhead overlay are deferred
  polish; the offline basemap already draws a graticule.)

Each phase ships token-driven, real-semantic, reduced-motion-aware, typechecked, built, screenshot-
verified, and CI-green — same cadence as M7.
