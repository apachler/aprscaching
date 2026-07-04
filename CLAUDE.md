# CLAUDE.md — aprscaching

## Rules (read before building/changing the relevant area)
@.claude/rules/ui-ux.md
@.claude/rules/css.md
@.claude/rules/ingest-locality.md
@.claude/rules/docs-and-comments.md

## What this is
APRScaching-first web workbench. APRScaching is the product; a full APRS workbench is the
platform. Author/owner: OE8APR.

## IP
APRScaching is the author's own work — build freely. Workbench capabilities are reimplemented
from OPEN specs (APRS101, APRS-IS, AX.25/KISS, Meshtastic, TAK/CoT). Never copy APRStac's
(KN4MKB) closed-source code/assets.

## Stack
pnpm monorepo. apps/web = React+MapLibre → Cloudflare Pages. workers/gateway = Worker + Durable
Objects + D1 + R2. **Canonical host = `aprscaching.net`** (the network peer + marketing landing +
platform); `aprscaching.com` 301-redirects to `.net` (pre-auth, edge). `INSTANCE`/`APP_URL`/`RP_ID`
= `.net`; API host `api.aprscaching.net`. WebAuthn `rpId` binds to one domain, so `.com` is a pure
redirect, never a sign-in origin.
apps/ingest = the operator-local RF/APRS-IS ingest (Pi/PC/mini-PC; a cloud box MAY run an IS-only
feed, never the RF bridge — `.claude/rules/ingest-locality.md`). packages/aprs = pure parser (runs in
Worker, Node, Bun, browser). packages/shared = zod contracts.

## Deployment
Five topologies (`deploy/`): **0** Bun single-binary desktop · **1** Pi at home (Cloudflare Tunnel) ·
**2** OCI all-in-one VM (Caddy) · **3** OCI core + Cloudflare CDN · **4** OCI ingest + CF Workers/D1/R2.
**Tri-runtime, all CI-conformance-green:** Node+SQLite (1–3, `servers/node`) · CF Worker+D1 (4,
`workers/gateway`) · Bun+`bun:sqlite` (0, `servers/bun` — smoke+geofence pass under Bun). RF ingest is
ALWAYS operator-local (local `apps/ingest` *or* browser Web Serial/BLE). Every instance MUST expose the
AGPL §13 Source link + back up its DB. The desktop topology is a `bun --compile` single binary with the
SPA + migrations embedded (`deploy/desktop/`); the rest of `deploy/` is validate-at-deploy.

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

## Cross-cutting invariants (hold these everywhere)
- **Identity, not call strings.** Leaderboards rank by callsign with profile aggregates per person;
  find authorship follows `account_id`, never the bare call string.
- **Source link.** A visible "Source" link + `/.well-known/source` is mandatory on every public
  instance (AGPL §13).
- **Read API is free** with per-IP limits + free keys. **Push** is permission/PWA-gated with a
  mandatory email-digest fallback.
- **GDPR/DSGVO.** Deletes propagate via signed federation tombstones; every user-facing datum lives
  inside the export/erase tools. Profiles are thin and opt-in — no name/address directory data.
- **Donations are recognition-only** — free-in-full, never feature-gating; `entitlements`/`api_keys`
  never gate features.
- **Transport ≠ trust.** Every internet-sourced packet (APRS-IS, AXIP/AXUDP, HAMNET-tunnelled) stays
  Tier C unless it arrives via a first-party RF site the operator attests. The `provenance`
  abstraction (transport enum + `firstPartyAttested` flag) is what the verify engine consumes — Tier A
  is gated on the flag, never on the transport.
- **RX ≠ trust; TX is gated.** Receiving a frame never lifts trust. Browser/RF transmit is off by
  default and gated on callsign control-verification; the APRS-IS passcode verifies nothing — the real
  gate is licensing + control-verification.
- **Weather is observational** — PWS ingest and WX beacons never touch the A/B/C find tiers.
- **Federation stays honest** — peer trust tiers + quarantine, a corroboration quorum, signed
  tombstones, signed account-move records, and owner-field redaction (`fed_scope`).
- **`packages/*` stay MIT-clean** and embeddable; never add AGPL-only deps there.

Post-1.0 deferred work is tracked in `TODO.md`.

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
smoke suites for green status. Cover: what's built, the runtimes (Worker/D1 + Node/SQLite + Bun,
tri-runtime CI), the trust model (tiers A/B/C vs account/callsign verification — keep them distinct),
identity/auth (passkey + email, multiple base-call accounts), federation, schema (migrations
0001–latest), the API surface, web-app structure, licensing, and the deferred items in `TODO.md`.
Keep it dense and current; flag what is NOT done.
