# About

## Privacy by default

Amateur radio is public by construction: every packet you transmit is heard by anyone with a receiver, and
aprscaching cannot and does not change that. What it *can* decide is what happens to those packets once they
reach an instance. Four invariants hold, and each one is code you can read rather than a promise in a policy.

**Positions expire.** The nightly job in `workers/gateway/src/app.ts` prunes firehose and browser-RF positions
older than seven days, in bounded batches so a backlog never stalls a small box. The raw packet ring is a
short-lived shack diagnostic and goes after 24 hours (`PACKETS_TTL_HOURS`); the message log, sensor readings,
port counters and node mheard rows carry their own TTLs (see the
[Configuration reference](reference/configuration.md)). The one deliberate exception is evidence: a position
that corroborates a find is kept as long as the find it verifies, because a Tier A find without its
corroborating fix is just a claim.

**No analytics, no advertising, no third-party trackers.** There is no measurement script, no ad network and
no external beacon anywhere in the app. The complete list of what an instance stores about you as a *visitor*
is one session cookie when you sign in, and short-lived per-IP counters for rate limiting. Every instance
serves that list at `GET /privacy`.

**The source is the receipt.** Because the app is AGPL-3.0, every public instance must expose the source it is
actually running — a visible link plus `GET /.well-known/source`, which returns the repository, the exact
commit, the tag and the licence. `GET /source` redirects to that commit's tree. A privacy claim you cannot
verify is marketing; this one you can diff.

**Or self-host and trust no one.** The same code runs as a desktop single binary, on a Raspberry Pi at home, on
your own VM, or on Cloudflare's edge — see [Deployment](operate/deployment.md). The RF ingest is *always*
runnable on your own equipment and is never cloud-only. Run your own instance and the retention schedule, the
data and the hardware are all yours.

Your own account data is yours to take or destroy: export and erase live under *Settings -> Data*, erasure
propagates to federation peers as signed tombstones, and owner contact fields are redacted from federated
records. Profiles are thin and opt-in — there is no name or address directory.

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
