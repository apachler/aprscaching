# aprscaching

**Find real places on the air.** aprscaching is an [APRS](glossary.md#aprs) geocaching game and ham-radio
**Shack**. You hide a cache, go find it, and log the find *verified by radio* — not only by tapping a button. Hide, hunt, operate. It runs in a browser, self-hosts on a Raspberry Pi, and federates
with other instances into one open network.

!!! tip "New here? [Start here](start-here.md)"
    Sign in at **[aprscaching.net](https://aprscaching.net)** with your callsign, verify it over APRS, and log
    your first find — no installation needed. [Start here](start-here.md) walks you through it in five
    minutes.

| I want to… | Start with |
|---|---|
| **Play** — find and hide caches, connect my radio | [Start here](start-here.md), then the [Guides](guides/caching.md) |
| **Run an instance** — for my club, my region, or off-grid | [Deployment](operate/deployment.md), then [Your first hour as sysop](operate/first-hour.md) |
| **Build on it** — the read API, signed feeds, federation | [HTTP API](reference/api.md) and [Federation wire format](reference/federation-wire.md) |
| **Contribute** — run the code, test, change it | [Run from source](getting-started.md) and [Testing & verification](reference/testing.md) |

A term you don't know is in the [Glossary](glossary.md).

## Two things in one application

**The cache game (for everyone).** A geocaching-style hunt where caches are places tied to amateur radio.
Browse a map, pick a nearby cache, and log a find when you get there — the app can prompt you the moment you
walk into a cache's geofence. Leaderboards, profiles, badges, and imported heritage summits and parks
(SOTA / POTA / WWFF / castles / islands) share the same map.

**The Shack (for the operator).** A real packet-radio bench: decode any APRS frame, watch a live station map,
run a store-and-forward BBS and a [NET/ROM](glossary.md#netrom) node, digipeat and [IGate](glossary.md#igate)
over a [KISS](glossary.md#kiss) [TNC](glossary.md#tnc), control a transceiver over [CAT](glossary.md#cat),
decode CW and PSK31 off the air, and extend it all with signed tool plugins. The caching side is the
*product*; the Shack is the *platform* it rides on.

## Trust follows the radio, not the transport

The single idea that shapes the whole platform: **a packet arriving over the internet proves nothing on its
own.** aprscaching only *believes* a find when independent evidence corroborates it, and that evidence has to
come from the air or from a first-party device reading — never merely from the wire a packet travelled on.
Every find earns one of three honest tiers: **Radio-verified** (A) when a receiving station that isn't yours
heard you on the air near the cache, **Location-verified** (B) when your own device's location matched it,
and **Logged** (C) when nothing independent placed you there — never more than that for a position that only
reached the instance over [APRS-IS](glossary.md#aprs-is). The badges are explained for players in
[Caching](guides/caching.md#log-a-find) and as precise rules in [Core concepts](concepts.md#verification-tiers).

## A map that forgets

Everything an amateur transmits is public, so the honest question is not whether a map can see your beacons —
it is what the map does with them afterwards. Here: firehose positions are pruned on a retention schedule
rather than archived, there is no analytics, advertising or third-party tracking of any kind, every instance
links the exact source commit it runs, and you can self-host the whole thing on your own hardware. Those four
invariants are spelled out, with the code behind each, under [About](about.md#privacy-by-default).

## Architecture at a glance

| Piece | What it is |
|-------|------------|
| **Gateway** | The API + data plane. Runs as a Cloudflare Worker + D1, plain Node + SQLite, or Bun — one conformance suite proves all three identical. |
| **Web app** | A React + MapLibre single-page app: the map, the Shack, and the operator surface. |
| **Ingest** | The operator-local RF bridge (a Pi/PC process, or the browser over Web Serial/Bluetooth). Always runnable on your own equipment; never cloud-only. |
| **Libraries** | Pure, reusable codecs (`@aprscaching/aprs`, `@aprscaching/ax25`, `@aprscaching/packet`, `@aprscaching/tools`) and typed contracts (`@aprscaching/shared`). |

Start with [Run from source](getting-started.md) to run it locally, or [Core concepts](concepts.md) to
understand the trust model before you deploy.
