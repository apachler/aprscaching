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

## What it is

- **The cache game.** Caches are places tied to amateur radio. Browse the map, go there, and log the find —
  verified **by radio** when a receiving station that isn't yours heard your APRS beacon nearby, by your
  phone's location otherwise. A packet that only travelled over the internet proves nothing on its own.
- **The Shack.** A packet-radio bench in the browser: an APRS decoder, a live station map, a BBS and NET/ROM
  node, an IGate and digipeater over a KISS TNC, rig control, CW and PSK31 decoding, and signed tool plugins.
- **Yours to run.** A Raspberry Pi, a mini-PC, a phone, a desktop app or Cloudflare — and the instances
  federate into one open network. Positions are pruned, nothing tracks you, and every instance links the
  exact source it runs.

## The manual

| I want to… | Start with |
|---|---|
| **Play** — find and hide caches, connect my radio | [Start here](https://apachler.github.io/aprscaching/start-here/) |
| **Run an instance** | [Deployment](https://apachler.github.io/aprscaching/operate/deployment/) and [Your first hour as sysop](https://apachler.github.io/aprscaching/operate/first-hour/) |
| **Build on it** — the read API, signed feeds, federation | [HTTP API](https://apachler.github.io/aprscaching/reference/api/) and [Federation wire format](https://apachler.github.io/aprscaching/reference/federation-wire/) |
| **Contribute** | [Run from source](https://apachler.github.io/aprscaching/getting-started/) and [CONTRIBUTING.md](CONTRIBUTING.md) |

How finds are verified is in [Core concepts](https://apachler.github.io/aprscaching/concepts/); the privacy invariants, with the code behind each,
are under [About](https://apachler.github.io/aprscaching/about/#privacy-by-default).

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

[Run from source](https://apachler.github.io/aprscaching/getting-started/) covers the Cloudflare Worker
gateway, the Bun desktop build and the ingest box, and
[Testing](https://apachler.github.io/aprscaching/reference/testing/) covers the smoke and conformance suites.

For an all-in-one Oracle Cloud VM there is a one-click path — you supply a callsign and an SSH key. It
deploys the stack archive attached to the latest release, so it works once the first release is published:

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
- **[TODO.md](TODO.md)** — the launch list and the work deferred past 1.0, with why each piece waits.

aprscaching is **free in full** — every feature, forever. Donations (when available) are
recognition-only and never gate functionality.
