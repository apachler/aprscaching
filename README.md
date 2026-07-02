# aprscaching

**Find real places on the air.** aprscaching is an APRS-caching game wrapped around a full amateur-radio
**APRS workbench** — hide a cache, go find it, and log the find *verified by radio*, not just by tapping a
button. It runs in your browser, self-hosts on a Raspberry Pi, and federates with other instances into one
open network.

Built by **OE8APR** from open specifications (APRS101, APRS-IS, AX.25/KISS, Meshtastic, TAK/CoT). Independent
and unofficial — see *Credits & trademarks*.

---

## What it is

Two things in one app:

- **The cache game (for everyone).** A geocaching-style hunt where "caches" are places tied to amateur
  radio. Browse a map, pick a nearby cache, and when you're there, log a find. The app can prompt you the
  moment you walk into a cache's geofence. Leaderboards, profiles, badges, and heritage summits/parks
  (SOTA / POTA / WWFF / castles / islands …) imported onto the same map.

- **The APRS workbench (for the operator).** A real packet-radio bench: decode any APRS frame, watch a live
  station map, run a store-and-forward BBS and a NET/ROM node, digipeat and IGate over a KISS TNC, control a
  transceiver over CAT, decode CW/PSK31 off the air, and extend it all with signed tool plugins. The caching
  side is the *product*; the workbench is the *platform* it rides on.

## Why "verified by radio" is the whole point

Anyone can claim they were somewhere. aprscaching only *believes* a find when the evidence corroborates it —
and **corroboration follows the radio, not the transport.** A packet that merely arrived over the internet
proves nothing on its own. Every find earns one of three honest tiers:

| Tier | Means | How it's earned |
|------|-------|-----------------|
| **A** | RF-corroborated | Heard on the air, gated by an IGate that isn't yours, on a plausible track |
| **B** | App-corroborated | Your phone's first-party geolocation matches the cache at log time |
| **C** | IS-only | A bare APRS-IS beacon — logged, but unverified |

The minimum tier a find must reach is a setting (site default **B**, with a per-cache override). A bare
internet packet can never reach Tier B by itself — the corroboration has to be an independent reading. This
rule holds across *every* transport: APRS-IS, an AXUDP/AXIP tunnel, or a HAMNET link are all just wires, and
none of them launder a packet into a higher tier. Only a receiving site *you* operate and vouch for yields
Tier A.

> At launch the trust model rests on **Tier B (app geolocation)** plus **honest Tier C** badging. Tier A is
> designed-for and lights up wherever an operator runs their own attested RF receiver.

## The workbench, in brief

Everything an operator needs, revealed progressively so the cacher never sees the machinery:

- **Decoder & inspector** — turn any raw frame into typed data: uncompressed / base-91 compressed / MIC-E
  positions (course, speed, altitude, ambiguity), objects & items, messages (acks, bulletins), status,
  weather, and telemetry. A live **station registry** and map, with heading arrows and per-station tracks.
- **Packet terminal, BBS & node** — a connected-mode AX.25 stack (mod-8 **and** mod-128 / SREJ), a
  store-and-forward **BBS** with FBB forwarding, a **NET/ROM node** (routing table, circuits, connect-through),
  a **digipeater** (new n-N paradigm, viscous cancellation) and a bidirectional **IGate**.
- **Radios & transports** — KISS/TNC over TCP, browser-direct **Web Serial / Bluetooth** KISS, **CAT** rig
  control (Web Serial, plus a Hamlib `rigctld` companion for the long tail), **Meshtastic**, **TAK/CoT** in
  and out, and internet AX.25 tunnels (**AXUDP** and **AXIP**). Off-air **CW** and **PSK31** decode straight
  from the microphone.
- **Weather** — APRS weather stations are first-class; originate your own PWS (Ecowitt / WU) into the network.
- **Remote & spots** — drive your own always-on ingest box from the web app; overlay live activation spots
  (POTA/SOTA/…) on the map.
- **Tools platform** — a plugin system with signed manifests and a registry: import third-party tools that
  add commands, decoders, colourisers, panels, and map layers, sandboxed off the main thread.

Transmit is **off by default and gated** — real on-air keying requires a verified callsign.

---

## Run it

```bash
pnpm install
pnpm -r test                 # every package's unit suite
pnpm -r build                # typecheck + build all units
```

**Web app + gateway (local):**
```bash
# gateway on Cloudflare Workers + D1 …
cd workers/gateway
npx wrangler d1 create aprscaching                    # paste database_id into wrangler.toml
npx wrangler d1 migrations apply aprscaching --local  # schema from ../../db/migrations
npx wrangler dev                                      # /health, /ingest, /api/*, /ws

# … or the self-host gateway on plain Node + SQLite (no Cloudflare needed)
pnpm --filter @aprsweb/node-gateway start             # same API, same conformance suite

# the map UI (VITE_API_BASE defaults to http://127.0.0.1:8787)
pnpm --filter @aprsweb/web dev
```

**Ingest box (operator-local RF):**
```bash
cp .env.example .env         # set APRSIS_FILTER + INGEST_SECRET; optional KISS_TNC_HOST, MESH_HOST, …
pnpm --filter @aprsweb/ingest dev
```

### Where it runs

The RF ingest is **always runnable on your own equipment** — a local process on a Pi/PC, or the browser
bridging a USB/BLE radio directly. It's never cloud-only. The rest of the stack has three interchangeable
shapes, proven byte-for-byte identical by one conformance suite that runs against all three in CI:

| Runtime | For | Storage |
|---|---|---|
| **Cloudflare Worker + D1** | edge / serverless | D1 (+ R2 media) |
| **Node + SQLite** (`servers/node`) | self-host on a Pi / VM | `better-sqlite3` |
| **Bun + bun:sqlite** (`servers/bun`) | a single-file desktop build | `bun:sqlite` |

Deployment recipes (Pi-at-home with a Cloudflare Tunnel, an all-in-one OCI VM with Caddy, a desktop
single-binary, …) live in `docs/design/23-deployment.md` and `deploy/`.

### Source link (AGPL §13)

Because the hosted app is AGPL, **every public instance must expose its own source** — a visible "Source"
link in the UI and a `/.well-known/source` endpoint pointing at the exact running commit. This is
launch-blocking by design: a hosted fork's users can always get its code.

---

## The open network

### Federation — signed, mirrorable feeds

Any instance (edge or self-host) publishes read-only, **Ed25519-signed** feeds so peers can mirror it into a
shared catalog:

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/aprscaching` | instance descriptor: protocol, public key, peers, capabilities |
| `GET /federation/caches` · `/finds` · `/keys` | signed, cursor-paged records (verified on mirror) |
| `POST /federation/sync` | pull from all peers |
| `POST /federation/corroborate` | "did you independently hear this callsign on RF near here?" |
| `POST /federation/submit` · `/federation/relay/*` | push-to-hub + a poll-based relay for firewalled peers |

Generate a key and set it as a secret to enable signing (feeds serve unsigned otherwise):

```bash
node tools/fedkey/genkey.mjs         # prints FED_PRIVATE_KEY + the public key it publishes
```

Point an instance at peers with `FED_PEERS=https://a.example,https://b.example`; it pulls and verifies their
feeds on a schedule and shows their caches on your map (read-only). Peer **trust tiers**, a corroboration
**quorum**, contradiction signals, and GDPR **tombstone** propagation keep the network honest as it opens up.
**Cross-instance corroboration is the network effect:** when a find can't reach Tier A locally, peers can
vouch that they independently heard the callsign on RF — the more instances and IGates, the more finds verify.

### Heritage imports

Pull third-party location programs onto your map — each with a source disclaimer + deep link, re-importing
updates in place, and de-duplicated across sources with ham-radio priority (a SOTA summit suppresses a
coincident OSM peak). Imported caches stay local (never published to the federation). Sources include SOTA,
POTA, WWFF, WWBOTA/UKBOTA, IOTA, Geocaching Australia, OpenCaching nodes, OSM, and Wikidata; licensing varies
by source and is attributed in-app.

### Per-callsign signing & your data

Each user holds an Ed25519 keypair in their browser and registers the public key to their callsign, so finds
are **signed on-device** — authorship is cryptographically tied to a callsign and stays attributable even
after you move instances. Passkeys (WebAuthn) or a device-key signature authorize sensitive account actions;
there's no central password to leak. Full **export** and **erase** (GDPR / DSGVO) live under *Settings → Your
data*, and a portable bundle lets you migrate a callsign between instances.

---

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
