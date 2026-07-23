# aprscaching

**Find real places on the air.** aprscaching is an APRS geocaching game and ham-radio **Shack**. You hide a cache, go find it, and log the find *verified by radio* — not just by
tapping a button. Hide, hunt, operate. It runs in a browser, self-hosts on a Raspberry Pi, and federates
with other instances into one open network.

This manual describes the platform as it is. It has three audiences:

- **Cachers** play the game — see [Caching](guides/caching.md).
- **Operators** run an instance and bridge it to real radio — see [Operating an instance](operate/deployment.md).
- **Integrators** talk to the platform's open, signed feeds and read API — see [Reference](reference/api.md)
  and [Federation](guides/federation.md).

## Two things in one application

**The cache game (for everyone).** A geocaching-style hunt where caches are places tied to amateur radio.
Browse a map, pick a nearby cache, and log a find when you get there — the app can prompt you the moment you
walk into a cache's geofence. Leaderboards, profiles, badges, and imported heritage summits and parks
(SOTA / POTA / WWFF / castles / islands) share the same map.

**The Shack (for the operator).** A real packet-radio bench: decode any APRS frame, watch a live
station map, run a store-and-forward BBS and a NET/ROM node, digipeat and IGate over a KISS TNC, control a
transceiver over CAT, decode CW and PSK31 off the air, and extend it all with signed tool plugins. The
caching side is the *product*; the Shack is the *platform* it rides on.

## Trust follows the radio, not the transport

The single idea that shapes the whole platform: **a packet arriving over the internet proves nothing on its
own.** aprscaching only *believes* a find when independent evidence corroborates it, and that evidence has to
come from the air or from a first-party device reading — never merely from the wire a packet travelled on.
Every find earns one of three honest tiers ([Core concepts](concepts.md#verification-tiers)):

| Tier | Means | Earned by |
|------|-------|-----------|
| **A** | RF-corroborated | Heard on the air, gated by an IGate that isn't yours, on a plausible track |
| **B** | App-corroborated | Your device's first-party geolocation matches the cache at log time |
| **C** | IS-only | A bare APRS-IS beacon — logged, but unverified |

## Architecture at a glance

| Piece | What it is |
|-------|------------|
| **Gateway** | The API + data plane. Runs as a Cloudflare Worker + D1, plain Node + SQLite, or Bun — one conformance suite proves all three identical. |
| **Web app** | A React + MapLibre single-page app: the map, the Shack, and the operator surface. |
| **Ingest** | The operator-local RF bridge (a Pi/PC process, or the browser over Web Serial/Bluetooth). Always runnable on your own equipment; never cloud-only. |
| **Libraries** | Pure, reusable codecs (`@aprscaching/aprs`, `@aprscaching/ax25`, `@aprscaching/packet`, `@aprscaching/tools`) and typed contracts (`@aprscaching/shared`). |

Start with [Getting started](getting-started.md) to run it locally, or [Core concepts](concepts.md) to
understand the trust model before you deploy.
