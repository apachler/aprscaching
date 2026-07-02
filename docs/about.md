# About

## Licensing

The monorepo is licensed **by unit** so the reusable parts stay broadly usable while the hosted service stays
open:

| Part | Licence | Why |
|------|---------|-----|
| **App & gateway** — `apps/`, `workers/gateway`, `servers/`, `db/`, `tools/` | **AGPL-3.0-or-later** | A hosted network service — the AGPL §13 network-use clause keeps any *hosted* fork's source open to its users, not just redistributed copies. |
| **Reusable libraries** — `packages/aprs`, `packages/ax25`, `packages/packet`, `packages/tools`, `packages/shared` | **MIT** | So other amateur-radio software can embed the decoders and contracts freely. |
| **Documentation** — `docs/` | **CC-BY-SA-4.0** | Free-culture share-alike for prose, specs, and diagrams. |

Each file's licence is that of the unit it lives in — every source file carries an `SPDX-License-Identifier`
header, and the per-package `LICENSE` files and `package.json` `license` fields are the machine-readable
source of truth. **Contributions are inbound = outbound**: opening a pull request licenses your change under
the same licence as the files it touches.

Because the hosted app is AGPL, every public instance must expose its own source — a visible "Source" link
and `GET /.well-known/source` pointing at the running commit. This is required, not optional. Being open
under these licences also satisfies **ARDC's** open-access requirement for grant funding.

## Credits & trademarks

**APRS** — the Automatic Packet Reporting System — was created by the late **Bob Bruninga, WB4APR**
(1948–2022), whose decades of work made everything this project builds on possible. *APRS* is his trademark.
This project is an **independent, unofficial** implementation built from open specifications (APRS101,
APRS-IS, AX.25/KISS, Meshtastic, TAK/CoT) and is **not affiliated with, sponsored by, or endorsed by** Bob
Bruninga or his estate. The APRScaching game and this application are the author's (OE8APR) own work.

Maps © OpenStreetMap contributors (ODbL), rendered with MapLibre GL. Imported heritage data carries its
source's own licence and disclaimer. The same credits appear in-app under *Settings → About & credits*.

## Design record

The engineering design notes and decision records that predate this manual are kept in the repository under
`docs/design/` for provenance. They are not part of the product manual — this manual describes the platform
as it is.
