# aprscaching

[![CI](https://github.com/apachler/aprscaching/actions/workflows/ci.yml/badge.svg)](https://github.com/apachler/aprscaching/actions/workflows/ci.yml)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/apachler/aprscaching?sort=semver)](https://github.com/apachler/aprscaching/releases)
[![Manual](https://img.shields.io/badge/manual-apachler.github.io-14b8a6)](https://apachler.github.io/aprscaching/)

**Find real places on the air.** aprscaching is an APRS geocaching game and ham-radio **Shack**. You hide a
cache, go find it, and log the find *verified by radio* — not just by tapping a button. Hide, hunt, operate.
It runs in a browser, self-hosts on a Raspberry Pi, and federates with other instances into one open network.

Built by **OE8APR** from open specifications (APRS101, APRS-IS, AX.25/KISS, Meshtastic, MeshCom, TAK/CoT).
Independent and unofficial — see [Credits & trademarks](#credits--trademarks).

> **New here? [Start here](https://apachler.github.io/aprscaching/start-here/).**
> Sign in at **[aprscaching.net](https://aprscaching.net)** with your callsign, verify it over APRS, and log
> your first find — no installation needed. [Start here](https://apachler.github.io/aprscaching/start-here/)
> walks you through it in five minutes.

The **[manual](https://apachler.github.io/aprscaching/)** describes the platform as it is. It has three
audiences:

- **Cachers** play the game — see [Start here](https://apachler.github.io/aprscaching/start-here/),
  [Your account](https://apachler.github.io/aprscaching/guides/account/) and
  [Caching](https://apachler.github.io/aprscaching/guides/caching/).
- **Operators** connect radios and run an instance — see
  [Your radio in the browser](https://apachler.github.io/aprscaching/guides/my-radio/),
  [Connect a radio: quick starts](https://apachler.github.io/aprscaching/operate/quickstarts/) and
  [Deployment](https://apachler.github.io/aprscaching/operate/deployment/).
- **Integrators** talk to the platform's open, signed feeds and read API — see
  [Reference](https://apachler.github.io/aprscaching/reference/api/) and
  [Federation](https://apachler.github.io/aprscaching/guides/federation/).

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
Every find earns one of three honest tiers
([Core concepts](https://apachler.github.io/aprscaching/concepts/#verification-tiers)):

| Tier | Means | Earned by |
|------|-------|-----------|
| **A** | RF-corroborated | Heard directly on the air by an attested receiving site that isn't yours — through that site's own ingest, never an APRS-IS copy — on a plausible track |
| **B** | App-corroborated | Your device's first-party geolocation matches the cache at log time |
| **C** | IS-only | A bare APRS-IS beacon — logged, but unverified |

## A map that forgets

Everything an amateur transmits is public, so the honest question is not whether a map can see your beacons —
it is what the map does with them afterwards. Here: firehose positions are pruned on a retention schedule
rather than archived, there is no analytics, advertising or third-party tracking of any kind, every instance
links the exact source commit it runs, and you can self-host the whole thing on your own hardware. Those four
invariants are spelled out, with the code behind each, under
[About](https://apachler.github.io/aprscaching/about/#privacy-by-default).

## Architecture at a glance

| Piece | What it is |
|-------|------------|
| **Gateway** | The API + data plane. Runs as a Cloudflare Worker + D1, plain Node + SQLite, or Bun — one conformance suite proves all three identical. |
| **Web app** | A React + MapLibre single-page app: the map, the Shack, and the operator surface. |
| **Ingest** | The operator-local RF bridge (a Pi/PC process, or the browser over Web Serial/Bluetooth). Always runnable on your own equipment; never cloud-only. |
| **Libraries** | Pure, reusable codecs (`@aprscaching/aprs`, `@aprscaching/ax25`, `@aprscaching/packet`, `@aprscaching/tools`) and typed contracts (`@aprscaching/shared`). |

Start with [Getting started](https://apachler.github.io/aprscaching/getting-started/) to run it locally, or
[Core concepts](https://apachler.github.io/aprscaching/concepts/) to understand the trust model before you
deploy.

---

## Run it from source

For developers. To install an instance, use the Docker stack in `deploy/`
([Running in Docker](https://apachler.github.io/aprscaching/operate/docker/)) or one of the
[deployment recipes](https://apachler.github.io/aprscaching/operate/deployment/). Needs Node 22+ and pnpm.

```bash
pnpm install
pnpm run check                                    # every unit's build + all unit suites
pnpm --filter @aprscaching/node-gateway dev       # the gateway on Node + SQLite
pnpm dev:web                                      # the map UI (talks to http://127.0.0.1:8787)
pnpm dev:ingest                                   # the operator-local RF ingest (copy .env.example to .env)
```

[Getting started](https://apachler.github.io/aprscaching/getting-started/) covers the Cloudflare Worker
gateway, the Bun desktop build and the ingest box, and
[Testing](https://apachler.github.io/aprscaching/reference/testing/) covers the smoke and conformance suites.

For an all-in-one Oracle Cloud VM there is a one-click path — you supply a callsign and an SSH key:

[![Deploy to Oracle Cloud](https://oci-resourcemanager-plugin.plugins.oci.oraclecloud.com/latest/deploy-to-oracle-cloud.svg)](https://cloud.oracle.com/resourcemanager/stacks/create?zipUrl=https://github.com/apachler/aprscaching/releases/latest/download/aprscaching-oci-stack.zip)

## Credits & trademarks

**APRS** — the Automatic Packet Reporting System — was created by the late **Bob Bruninga, WB4APR**
(1948–2022), whose decades of work made everything this project builds on possible. *APRS* is his trademark.
This project is an **independent, unofficial** implementation built from open specifications and is **not
affiliated with, sponsored by, or endorsed by** Bob Bruninga or his estate. The APRScaching game and this
application are the author's (OE8APR) own work.

Maps © OpenStreetMap contributors (ODbL), rendered with MapLibre GL; imported heritage data carries its
source's own licence and disclaimer. The same credits appear in-app under *Settings → About & credits*.

## License

The monorepo is licensed **by unit** so the reusable parts stay broadly usable while the hosted service stays
open:

| Part | Licence | Why |
|---|---|---|
| **App & gateway** — `apps/`, `workers/gateway`, `servers/`, `db/`, `tools/` | **AGPL-3.0-or-later** (`LICENSE`) | A hosted network service — the AGPL §13 network-use clause keeps any *hosted* fork's source open to its users. |
| **Reusable libraries** — `packages/aprs`, `packages/ax25`, `packages/packet`, `packages/tools`, `packages/shared` | **MIT** (per-package `LICENSE`) | So other amateur-radio software can embed the decoders and contracts freely. |
| **Documentation** — `docs/` | **CC-BY-SA-4.0** (`docs/LICENSE`) | Free-culture share-alike for prose, specs, and diagrams. |

Each file's licence is the one of the unit it lives in; the per-package `LICENSE` files and the `license`
field in every `package.json` are the machine-readable source of truth. **Contributions are inbound =
outbound** — opening a pull request licenses your change under the same licence as the files it touches.

Being open under these licences also satisfies **ARDC's** open-access requirement for grant funding.

**Running a public instance?** Every instance exposes its source (AGPL §13): a visible *Source* link and a
machine-readable **`GET /.well-known/source`** pointing at the exact running commit. If you host a
**modified** instance, set `SOURCE_REPO` (and, if you can, `SOURCE_COMMIT`) to your fork before you deploy.

## Contributing & community

Contributions from hams, developers, and cachers are welcome.

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — dev setup, the test/smoke commands, the load-bearing
  invariants, Conventional Commits, and DCO sign-off.
- **[SECURITY.md](SECURITY.md)** — how to report a vulnerability privately.
- **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)** · **[SUPPORT.md](SUPPORT.md)** ·
  **[CHANGELOG.md](CHANGELOG.md)**
- **[TODO.md](TODO.md)** — the short post-1.0 deferred list.

aprscaching is **free in full** — every feature, forever. Donations (when available) are
recognition-only and never gate functionality.
