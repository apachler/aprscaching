# CLAUDE.md — aprscaching.com (reborn)

## Design rules (read before building/changing any UI)
@.claude/rules/ui-ux.md
@.claude/rules/css.md

## What this is
APRScaching-first web workbench. APRScaching is the product; a full APRS workbench is the
platform. Greenfield (no legacy migration). Author/owner: OE8APR.

## IP
APRScaching is the author's own work — build freely. Workbench capabilities are reimplemented
from OPEN specs (APRS101, APRS-IS, AX.25/KISS, Meshtastic, TAK/CoT). Never copy APRStac's
(KN4MKB) closed-source code/assets.

## Stack
pnpm monorepo. apps/web = React+MapLibre → Cloudflare Pages. workers/gateway = Worker + Durable
Objects + D1 + R2. **Canonical host = `aprscaching.net`** (the first network peer + marketing landing
+ platform); `aprscaching.com` 301-redirects to `.net` (pre-auth, edge). `INSTANCE`/`APP_URL`/`RP_ID`
= `.net`; API host `api.aprscaching.net`. WebAuthn `rpId` binds to one domain → `.com` is a pure
redirect, never a sign-in origin (see `docs/18`).
apps/ingest = always-on APRS-IS forwarder (Fly/Railway/Pi). packages/aprs = pure parser
(runs in Worker, Node, browser). packages/shared = zod contracts.

## Verification (the core)
Trust follows corroboration, not transport:
- A RF-corroborated: qAR + independent IGate + plausible track.
- B App-corroborated: first-party in-app device geolocation matches the cache (phone-app path).
- C IS-only: bare APRS-IS beacon — logged but unverified.
A bare IS packet alone CANNOT reach tier B; corroboration must be the independent app reading.
Min accepted tier is a config policy (site default `B`; per-cache `min_trust` overrides).
See workers/gateway/src/verify.ts.

## Cost rules
Filter APRS-IS server-side; persist selectively; batch ingest POSTs; DO Hibernation API only
(`acceptWebSocket` + `serializeAttachment`); TTL firehose positions nightly (keep logger
positions longer for verification); TX off by default + gated.

## Commands
pnpm install
pnpm --filter @aprsweb/aprs test
pnpm --filter @aprsweb/gateway dev      # wrangler dev (after d1 create + migrate)
pnpm --filter @aprsweb/ingest dev       # needs .env (copy .env.example)
pnpm --filter @aprsweb/web dev

## Build order
M0 spine (this scaffold) → M1 caching core → M2 verification+geofencing → M3 import/heritage
→ M4 community/gamify → M5 workbench depth → M6 headroom.

Cross-cutting decisions are recorded in `docs/14-open-decisions.md` (ADR set, ACCEPTED): leaderboard
ranks by callsign + profile aggregates per person (ADR-1); find authorship follows `account_id`, never
the bare call string (ADR-2); a visible "Source" link + `/.well-known/source` is **launch-blocking**
before first public deploy (ADR-3, AGPL §13); read API is free with per-IP limits + free keys (ADR-4a);
push is permission/PWA-gated with a mandatory email-digest fallback (ADR-4b); GDPR deletes propagate via
signed federation tombstones (ADR-5).

Backlog tracks fold into the milestones above (build each feature against its doc; all MUST
hold the ui-ux/css rules — progressive disclosure, opt-in raster, reduced-motion, the cost model):
- Adopted map & UX features — `docs/11-adopted-map-features.md`:
  M1 vector basemap + layer switcher · save/share view (URL state) · favorites + basic search;
  M2 topo/satellite layers · ruler+navigate · range rings + grid/MGRS · cache page (finds-over-time)
  · enriched search; M3 track history by date · time-replay · GPX/KML export · public read API;
  M4 deep-link/embeddable widget + QR · push alerts (nearby/new-cache/DNF) · API keys;
  M5 station telemetry/weather graphs · raw packet view (workbench).
- Sustainability & supporter donations — `docs/12-sustainability-donations.md` (free-in-full,
  recognition-only, never feature-gating): Now (no code) donation links + transparency page (the
  open-source LICENSE that unlocks the ARDC grant is **done** — AGPL-3.0 app/gateway · MIT libraries
  · CC-BY-SA-4.0 docs); M4 supporter badge + hide-nag + `/support` ledger; M5 peer cost-reimbursement
  (Open Collective). Monetization schema lands as migration **`0012`** (`docs/14`), not the `0003`
  the doc names retrospectively; `entitlements`/`api_keys` are recognition-only, never feature gates.
- Profiles — `docs/13-profiles.md`: a thin, opt-in ham profile (display name, locator, avatar, bio,
  links, operated SSIDs, opt-in public contact) — borrow QRZ's self-curated profile, reject its
  name/address directory data (off-mission + DSGVO). M4 basic profile + Settings→Profile group;
  M5 operated SSID stations (needs `account_stations`). One small `accounts` migration; all inside
  the existing GDPR export/erase.
- Landing & onboarding (mechanics) — `docs/18-landing-and-onboarding.md`: marketing landing + the
  signed-out flow. **Mechanics only — content (copy, tour steps) deferred while the platform churns.**
  Signed-in skips the landing (full mode); signed-out sees landing (Register/Login/Explore); Explore →
  read-only platform (already open-browse) + an accessible, reduced-motion, config-driven quick-tour
  framework with placeholder steps. `.com`→`.net` pre-auth redirect; rpId binds to `.net` only.
  **L2–L4 mechanics IMPLEMENTED** (Landing.tsx · App.tsx gate · ui/Tour.tsx); **L1 domain/redirect
  PENDING** (deployment); landing copy + real tour steps still deferred.
- Weather stations — `docs/17-weather-stations.md`: APRS weather is first-class and the RX side is
  built (`decode.ts` wx parse → `sensor_readings`; shown on station page). Adds user-origination of
  their own PWS: W1 direct platform ingest (Ecowitt / WU-Rapidfire → `-13` weather SSID, no licence) ·
  W2 APRS WX beacon TX (gated, verified callsign) · W3 CWOP relay (feeds NOAA) · W4 browser-direct
  Davis/Ultimeter via Web Serial (with `docs/16`). Small additive `sensor_readings` migration (gust,
  split rain, luminosity, snow, source). Weather is observational — never touches the A/B/C find tiers.
- RF hardware interfacing — `docs/16-rf-hardware-interfacing.md`: two paths, one shared codec
  (`@aprsweb/aprs` KISS/AX.25 framing is already pure). Path A = the always-on ingest box (KISS-over-TCP,
  CoT, Meshtastic, IGate/digi — built; iOS-capable). Path B = browser-direct via Web Serial / Web
  Bluetooth (**adopt the BLE-KISS API**) / WebUSB / Web Audio (in-browser Bell-202 AFSK = no-TNC mode),
  Chromium-only, not iOS. H1 Web Serial KISS · H2 BLE-KISS · H3 Meshtastic/LoRa · H4 soundcard AFSK ·
  H5 gated browser TX (callsign-verified, opt-in). Recommended hw: DigiRig, NinoTNC, Mobilinkd TNC4,
  Kenwood TH-D74/75, Meshtastic ESP32, RTL-SDR+Direwolf. RX ≠ trust — still gated by `verify.ts`.
- CAT rig control & companion apps — `docs/21-cat-control-and-companions.md` (adopts WAAT's serial→
  WebSocket/JSON-RPC *pattern*, not its one-rig engine): one rig-control API, two backends —
  browser-direct Web Serial CAT (Kenwood/Icom-CIV/Yaesu, `docs/16` H6) + a **Hamlib `rigctld`
  companion** for the 200+ rig long tail (capability negotiation; `rigctld` as a separate process →
  no GPL contamination). Companions close the browser's RF gaps: Linux/Pi = productized `apps/ingest`
  (Hamlib CAT + gateway remote channel + `docker`/`.deb`/AppImage); mobile = a **Capacitor shell**
  reusing the web app + native USB-serial/BLE-KISS/background (iOS RF = BLE here only). All keying
  H5-gated. OmniRig=Windows-only, grig=reference.
- Live spots & remote control — `docs/20-live-spots-and-remote-control.md` (reframed from POTACAT,
  Apache-2.0): a **live activity-spots layer** (POTA/SOTA/WWBOTA/GMA + DX-cluster/RBN/PSKReporter on
  the map, opt-in/filtered/deduped; "being activated now" on coincident caches) and **remote control
  of your own ingest box** via the gateway-as-cloud-relay (ECHOCAT pattern; no port-forward; beacon/
  message/TX-IGate, H5-gated). Off-mission HF machinery (FT8/SSTV/FreeDV/CW/panadapter/DXCC) NOT
  adopted. Small extensions live in their home docs: Web Serial CAT one-click tune → `docs/16` H6;
  day/night + bearing arc + ADIF export + watchlist alerts → `docs/11`.
- APRS-IS identity & passcodes — `docs/19-aprs-is-identity.md`: the passcode verifies *nothing*
  (public hash; APRS-IS won't block invented calls) — the real gate for RF is **licensing** +
  our control-verification, never the passcode. Peer service id = `<licensedCall>-<SERVICE_SSID>`
  (network-fixed SSID) + shared `TOCALL` + a federation-registry `aprsCall` binding (directly
  addressable; ties to `docs/15` T4.2). TOCALL: `APZACG` now (self-assigned), register an `APAC…`
  via `aprsorg/aprs-deviceid` (we qualify as a service). Adopt **LoTW-TLS** APRS-IS auth (proper,
  passwordless). Users never enter a passcode: gated via the peer (third-party/`qAR`, verification-
  gated) or direct (auto-computed passcode/LoTW, verified + opt-in, `docs/16` H5). RX-only = `-1`.
- Federation next level (F4–F7) — `docs/15-federation-next.md`: takes live federation (F0–F3) further.
  F4 trust (**launch-gating** before opening the network): peer trust tiers + quarantine, corroboration
  **quorum** + hardening (parallel, grid/time-bucket privacy, rate-limit), ADR-5 tombstones. F5 reach:
  gossip ping (push-to-pull), generalized signed-feed envelope + capability negotiation. F6 commons:
  federated catalog in read API + map, account-move as a signed record (pairs ADR-2), owner field
  redaction (`fed_scope`, no hint on the wire). F7 governance: key rotation/multi-key, signed instance
  registry (namespace authority), observability. Resolves docs/06 #2/#3/#4. New migrations after `0012`.

## Licensing
Monorepo licensed by unit (see `LICENSE`, per-package `LICENSE`, README "License"): hosted app &
gateway (`apps/`, `workers/gateway`, `servers/node`, `db/`, `tools/`) = **AGPL-3.0-or-later**;
reusable libraries (`packages/aprs`, `packages/shared`) = **MIT**; docs (`docs/`) = **CC-BY-SA-4.0**.
New code inherits the licence of its unit. Keep `packages/*` MIT-clean (embeddable); never add
AGPL-only deps there. Contributions are inbound=outbound.

## Regenerating the codebase-state summary (for planning-chat context)
On demand ("give me a state summary"), produce a ONE-SHOT markdown digest for pasting into the
planning chat — print it in chat, do NOT commit it. Rebuild it fresh from the repo, don't trust an
old copy. Gather: `git log --oneline -25`; `ls db/migrations` + `ls docs`; `ls workers/gateway/src`
(+ `apps/web/src`, `packages/aprs/src`); the route table via `grep -oE 'p === "[^"]+"' workers/
gateway/src/app.ts` plus the regex segment-routes lower in `app.ts`; `pnpm -r test` + the three
smoke suites for green status; and skim `docs/10`/`11`/`12` Status sections. Cover: what's built
(M0–M9 + the milestone themes), runtimes (Worker/D1 + Node/SQLite, dual-runtime CI), the trust
model (tiers A/B/C vs account/callsign verification — keep them distinct), identity/auth state
(passkey + email, multi base-call accounts), federation, schema (migrations 0001–latest), the API
surface, web app structure, licensing, and the open backlog/deferred items. Keep it dense and
current; flag what is NOT done.
