# aprscaching

[![CI](https://github.com/apachler/aprscaching/actions/workflows/ci.yml/badge.svg)](https://github.com/apachler/aprscaching/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/apachler/aprscaching/badge)](https://scorecard.dev/viewer/?uri=github.com/apachler/aprscaching)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/apachler/aprscaching?sort=semver)](https://github.com/apachler/aprscaching/releases)
[![Manual](https://img.shields.io/badge/manual-apachler.github.io-14b8a6)](https://apachler.github.io/aprscaching/)

**Find real places on the air.** aprscaching is an APRS geocaching game and ham-radio **Shack**. You hide a
cache, go find it, and log the find *verified by radio* — not just by tapping a button. Hide, hunt, operate.
It runs in a browser, self-hosts on a Raspberry Pi, and federates with other instances into one open network.

Built by **OE8APR** from open specifications (APRS101, APRS-IS, AX.25/KISS, Meshtastic, MeshCom, TAK/CoT).
Independent and unofficial — see [Credits & trademarks](#credits--trademarks).

> **New here? [What is APRScaching?](https://apachler.github.io/aprscaching/play/)**
> Sign in at **[aprscaching.net](https://aprscaching.net)** with your callsign, verify it over APRS, and log
> your first find — no installation needed. [Your first find](https://apachler.github.io/aprscaching/play/first-find/)
> walks you through it in five minutes.

## What it is

- **The cache game.** Caches are places tied to amateur radio. Browse the map, go there, and log the find —
  verified **by radio** when a receiving station that isn't yours heard your APRS beacon nearby, by your
  phone's location otherwise. A packet that only travelled over the internet proves nothing on its own.
- **The Shack.** A packet-radio bench in the browser: an APRS decoder, a live station map, a BBS and NET/ROM
  node, an IGate and digipeater over a KISS TNC, rig control, CW and PSK31 decoding, and signed tool plugins.
- **Yours to run.** A Raspberry Pi, a mini-PC, a free Oracle Cloud VM, a phone or a desktop app — and the instances
  federate into one open network. Positions are pruned, nothing tracks you, and every instance links the
  exact source it runs.

## One network, no central server

Every instance is complete on its own, and instances link up directly, sysop to sysop. Caches hidden on one
instance appear on the maps of the others; a find logged on one can be confirmed by radio receivers on others;
a deletion travels everywhere the record went. Every record is signed by the instance it comes from, so it can
travel over the internet, 44Net or HAMNET (or, experimentally, as packet mail) and no path in between can alter
it. Each sysop decides whom to trust, and no company, registry or server sits in the middle.
[How federation works](https://apachler.github.io/aprscaching/run/federation/how-it-works/) and
[Choose how to connect](https://apachler.github.io/aprscaching/run/federation/choose/) explain it.

## The manual

| I want to… | Start with |
|---|---|
| **Play** — find and hide caches | [What is APRScaching?](https://apachler.github.io/aprscaching/play/) |
| **Operate** — my radio, packet and the Shack apps | [The Shack at a glance](https://apachler.github.io/aprscaching/shack/) |
| **Run an instance** | [Is running an instance for me?](https://apachler.github.io/aprscaching/run/) and [Your first hour](https://apachler.github.io/aprscaching/run/first-hour/) |
| **Build on it** — the read API, signed feeds, federation | [HTTP API](https://apachler.github.io/aprscaching/reference/api/) and [Federation wire format](https://apachler.github.io/aprscaching/reference/federation-wire/) |
| **Contribute** | [Run from source](https://apachler.github.io/aprscaching/contribute/run-from-source/) and [CONTRIBUTING.md](CONTRIBUTING.md) |

How finds are verified is in [How finds are verified](https://apachler.github.io/aprscaching/play/verification/) and, as precise rules, [The trust model](https://apachler.github.io/aprscaching/reference/trust-model/); the privacy invariants, with the code behind each,
are under [About](https://apachler.github.io/aprscaching/about/#privacy-by-default).

---

## Run it from source

For developers. To install an instance, use the Docker stack in `deploy/`
([Self-host with Docker](https://apachler.github.io/aprscaching/run/install/self-host-docker/)) or another
[shape](https://apachler.github.io/aprscaching/run/choose-a-shape/). Needs Node 22+ and pnpm.

```bash
pnpm install
pnpm run check      # every unit's build + all unit suites
pnpm dev            # gateway + web app on http://localhost:5173, reloading on every edit
pnpm dev --ingest   # also the operator-local RF/APRS-IS ingest
```

[Run from source](https://apachler.github.io/aprscaching/contribute/run-from-source/) covers the Bun desktop build
and the ingest box, and
[Testing](https://apachler.github.io/aprscaching/contribute/testing/) covers the smoke and conformance suites.

For an all-in-one Oracle Cloud VM there is a one-click path — you supply a callsign and an SSH key
([Self-host on Oracle Cloud](https://apachler.github.io/aprscaching/run/install/oracle-cloud/)). It deploys the
stack archive attached to the latest release, so it works once the first release is published:

[![Deploy to Oracle Cloud](https://oci-resourcemanager-plugin.plugins.oci.oraclecloud.com/latest/deploy-to-oracle-cloud.svg)](https://cloud.oracle.com/resourcemanager/stacks/create?zipUrl=https://github.com/apachler/aprscaching/releases/latest/download/aprscaching-oci-stack.zip)

## Credits & trademarks

APRS — the Automatic Packet Reporting System — was created by the late **Bob Bruninga, WB4APR** (1948–2022),
whose decades of work made everything this project builds on possible. APRS® is a registered trademark (U.S. Reg.
No. 2058846). APRScaching is an **independent, unofficial** implementation built from open specifications
(APRS101, APRS-IS, AX.25/KISS, Meshtastic, TAK/CoT). APRScaching is not affiliated with or endorsed by the holder
of the APRS® mark. The APRScaching game and this application are the author's (OE8APR) own work.

Meshtastic® is a registered trademark of Meshtastic LLC. Meshtastic software components are released under various
licenses, see GitHub for details. Parks on the Air® is a registered service mark of Parks on the Air, Inc. Summits on the Air, SOTA and the SOTA logo are trademarks of the SOTA Programme. LoTW® and Logbook of
The World® are registered trademarks of the American Radio Relay League, Inc. (ARRL). Geocaching® is a registered
trademark of Groundspeak, Inc. (Geocaching HQ); “geocaching” here names the outdoor activity. APRScaching is not
affiliated with, sponsored by, or endorsed by Groundspeak, Inc. (Geocaching HQ), Geocaching Australia, Meshtastic
LLC, ARRL, Parks on the Air (POTA), Summits on the Air (SOTA), World Wide Flora and Fauna (WWFF), World Wide Bunkers
on the Air (WWBOTA), Islands on the Air (IOTA), or the TAK Product Center.

Maps © OpenStreetMap contributors (ODbL), rendered with MapLibre GL; vector tiles © OpenFreeMap, © OpenMapTiles.
Optional layers: OpenTopoMap (Map data: © OpenStreetMap contributors, SRTM | Map style: © OpenTopoMap (CC-BY-SA))
and EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016).
Imported places name
and link their source; that source's own terms apply to its data. DXCC entities and prefixes come from the Amateur
Radio Country Files by Jim Reisert, AD1C (MIT).

Licence badges come from public registers. USA: FCC Universal Licensing System. Canada: ISED amateur callsign list,
reproduced from ised-isde.canada.ca. Australia: Based on Australian Communications and Media Authority information.
Austria: Fernmeldebehörde. Germany: Bundesnetzagentur.

Type: Fredoka and IBM Plex Mono (SIL Open Font License 1.1); the Phosphor theme's CP437 face is from The Ultimate
Oldschool PC Font Pack v2.2 by VileR (int10h.org), CC BY-SA 4.0. Built on open source, among others React, MapLibre
GL, uPlot, zod, pmtiles, fflate and node-forge: the web app serves the copyright notices and licence texts
of every library in its bundle at `/third-party-notices.txt`. The desktop app includes the Bun runtime (MIT, with
JavaScriptCore under the LGPL 2.1); its notices ship beside the binary. The same credits appear in-app under
*Settings → Help & credits*.

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
