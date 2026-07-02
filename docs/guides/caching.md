# Caching

The cache game is the product. This chapter covers hiding caches, logging finds, and everything on the map.

## Cache types

| Type | What it is |
|------|------------|
| **Traditional** | A fixed location to find. |
| **Virtual** | A place to confirm you visited, with no physical container. |
| **Multi / staged** | Several stages; each stage's coordinates are revealed only after you unlock the previous one. |
| **Living (`aprs_living`)** | A moving cache tied to an APRS station's beacon — found by being co-located with it. |
| **Heritage** | Summits, parks, and landmarks imported from other programs (SOTA, POTA, WWFF, castles, islands). |

Each cache carries difficulty and terrain, an optional per-cache **minimum trust tier** (`min_trust`), a
**federation scope** (`public` / `unlisted` / `local-only`), a rating policy, and tags.

## Hide a cache

`POST /api/caches` creates a cache and mints a short code (`AC-####`). You own it: you can edit it, set
staged coordinates, attach media, and choose whether it federates. Turning a cache `local-only` retracts any
mirrored copies from peers via a signed tombstone.

## Log a find

`POST /api/caches/:id/logs` records a find, DNF, note, or maintenance entry. A **found** log is scored into a
verification tier — see [Core concepts](../concepts.md#verification-tiers):

- **Tier A** when your position was heard on RF at a first-party-attested site, gated by an IGate that isn't
  yours, within the cache radius (default 150 m) on a plausible track — or when federation peers corroborate
  that independently.
- **Tier B** when your device's in-app geolocation matches the cache at log time (tolerance = the cache
  radius plus your reported accuracy, capped).
- **Tier C** for a bare APRS-IS beacon near the cache.

A cache owner can require a stricter tier with `min_trust`; a find that doesn't meet a cache's floor is
recorded but marked unverified.

## Staged & multi caches

`cache_stages` defines an ordered sequence. Stage 0 is public; later stages' coordinates stay hidden until
you unlock the prior stage. Unlock modes:

- **geo** — be within the previous stage's radius (in-app geolocation);
- **nfc** — read a physical tag's secret (WebNFC, with a typed fallback);
- **audio / open** — an advisory clue.

Owners set stages with `POST /api/caches/:id/stages` and may attach an audio clue per stage.

## Living-cache rendezvous

When two opted-in living caches beacon within 150 m of each other in a 15-minute window, the platform records
a mutual **rendezvous**. This is a social record only — it earns no points and no leaderboard credit, so
stations parking together cannot farm finds.

## The map & exports

The map aggregates your native caches and trust-filtered federated mirrors (native always shown, `trusted`
mirrors on by default, `unvetted` behind an "include network data" toggle). Client features include layer
switching, save/share of the current view by URL, range rings and MGRS, per-station track replay, and
navigate-to. The public read API (`/api/v1`, rate-limited) exports:

- caches as **GPX** and **KML**;
- station tracks as JSON and KML;
- a callsign's finds as **ADIF 3.1** (mapped to QSOs with `SIG=APRSCACHING`).

## Community

Favorites, ratings (finders-only, everyone, or off, per the cache's policy), badges and achievements for both
hiding and finding, and cache health signals (needs-maintenance, DNF streaks). Leaderboards rank finders by
metric, period, and area; a public profile aggregates a callsign's finds, hides, and points. A corroborator
board credits the IGates that make other people's finds verifiable, and an operator's standing is exportable
as an embeddable SVG badge (`/badge/:call.svg`).

## Heritage imports

Operators can pull third-party location programs onto the map with `POST /api/import/:source`:

| Source | Notes |
|--------|-------|
| SOTA, POTA, WWFF, WWBOTA/UKBOTA, IOTA | Amateur activity programs (region or bbox scoped). |
| Geocaching Australia, OpenCaching nodes | Geocache catalogs (OpenCaching needs a per-node key). |
| OSM, Wikidata | Peaks, castles, lighthouses (ODbL / CC0). |
| Generic GeoJSON | Any catalog, incl. WCA castles via CQGMA. |

Each imported cache carries a source disclaimer and a deep link back to the origin, re-importing updates it
in place, and imports are de-duplicated across sources with **ham-radio priority** (a SOTA summit suppresses
a coincident OSM peak). Imported caches stay **local** — they are never re-published to the federation.
