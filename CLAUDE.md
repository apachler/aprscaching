# CLAUDE.md — aprscaching

## Rules (read before building/changing the relevant area)
@.claude/rules/ui-ux.md
@.claude/rules/css.md
@.claude/rules/ingest-locality.md
@.claude/rules/docs-and-comments.md

## What this is
APRScaching-first web app. APRScaching is the product; **the Shack** — a full ham-radio
operator platform — is what it rides on. "Shack" is the one term everywhere: UI labels, docs,
marketing, and code identifiers (`shack`) alike.
Author/owner: OE8APR.

## IP
APRScaching is the author's own work — build freely. Shack capabilities are reimplemented
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
Three topologies (`deploy/`): **Desktop** — the Bun single binary (`deploy/desktop/`, SPA + migrations
embedded) · **Self-host** — the Docker stack (gateway + ingest + Caddy) on a Pi, mini-PC or VM, reached through
Caddy TLS or a Cloudflare Tunnel (`compose.home.yml`), optionally behind Cloudflare's CDN · **Cloudflare** —
Worker + D1 + R2 + Pages (`deploy/cloudflare/deploy-cf.sh`). **Tri-runtime, all CI-conformance-green:**
Node+SQLite (self-host, `servers/node`) · CF Worker+D1 (Cloudflare, `workers/gateway`) · Bun+`bun:sqlite`
(desktop, `servers/bun` — smoke+geofence pass under Bun). RF ingest is ALWAYS operator-local in every topology
(local `apps/ingest` / `compose.ingest-only.yml` *or* browser Web Serial/BLE). `deploy/setup.sh` writes a
self-host `.env` in one step (`--non-interactive` for scripts); `INSTANCE` and `RP_ID` default to `APP_URL`'s
host. Every instance MUST expose the AGPL §13 Source link + back up its DB; the rest of `deploy/` is
validate-at-deploy.

## Verification (the core)
Trust follows corroboration, not transport:
- A RF-corroborated: heard directly by an attested site's own receiver (a TNC or MeshCom port on its own
  ingest box, delivered with the ingest secret) that is independent of the logger + plausible track. An
  APRS-IS line naming the site (`qAR,<site>`) never counts — APRS-IS passcodes are public.
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
Node ≥ 22 (CI uses 24); pnpm is pinned via `packageManager` (use `corepack pnpm` if it isn't on PATH).
```
pnpm install
pnpm run check        # every unit's tsc build + all vitest suites + web typecheck/build — the inner loop
pnpm run smoke        # boots a throwaway Node/SQLite gateway and runs tools/smoke/{smoke,geofence}.mjs
pnpm run verify       # check + smoke — the full gate before committing
pnpm lint && pnpm format:check      # CI also runs `pnpm lint:types` (type-aware, slow)

pnpm --filter @aprscaching/aprs test                          # one package
pnpm --filter @aprscaching/aprs exec vitest run test/foo.test.ts -t "name"   # one file / one test
tools/dev/smoke.sh geofence                                   # one smoke suite
tools/dev/smoke.sh federation                                 # two-instance federation e2e

pnpm --filter @aprscaching/gateway migrate && pnpm dev:gateway   # wrangler dev on a local D1
pnpm --filter @aprscaching/node-gateway dev                      # same app on Node + SQLite
pnpm dev:ingest       # needs .env (copy .env.example)
pnpm dev:web
```
`apps/web`'s `test` runs two guard scripts (no emoji, tour anchors resolve) and a vitest suite over its
pure logic modules (`apps/web/test/*.test.ts`, no DOM); its other check is `typecheck`. The federation smoke (`tools/smoke/federation.mjs`) needs two
instances: `tools/dev/smoke.sh federation` boots a publisher and a subscriber on free ports with the env of
the CI `conformance-federation` job (`.github/workflows/ci.yml`). It is not part of `pnpm run smoke`.

## Architecture: one gateway, three runtimes
- `workers/gateway/src/app.ts` exports a runtime-neutral `handle()` (plus `runScheduled` /
  `runFrequentSync`); routing is the `p === "/…"` table plus regex segment routes in that file. Each
  feature is one module beside it (`verify.ts`, `webauthn.ts`, `ingest.ts`, …); federation is
  `federation.ts` (descriptor, keys, registry) plus `fedpull.ts` / `fedapply.ts` / `fedpush.ts` /
  `fedpeers.ts`, and every incoming signed frame is admitted by `fedapply.ts` `admitFrame()`.
- `servers/node` and `servers/bun` import that same app and supply the Cloudflare bindings
  themselves: a D1-compatible shim over better-sqlite3 / `bun:sqlite` (`d1.ts`), a socket adapter
  over the shared `rooms-core.ts` for the `RegionRoom` Durable Object (live WebSocket fan-out),
  filesystem media for R2, and the shared `migrate.ts` runner. Bun reuses the Node host modules, and the
  desktop launcher wraps `servers/bun/server.ts`'s `createServer()`. Fix behaviour in
  `workers/gateway`, never in one runtime's shim.
- The schema lives once in `db/migrations/*.sql` (one `0001_baseline.sql`; changes are new numbered files); wrangler applies it to D1
  (`migrations_dir = "../../db/migrations"`) and the Node/Bun servers apply it at boot.
- CI proves parity by running the same `tools/smoke/*` suites against all three runtimes.
- Tier A is default-deny: smoke/conformance runs need `FIRST_PARTY_SITES` naming the attested site,
  and writes need a shared `INGEST_SECRET` on both gateway and client.

## Git & dependencies
- Branch flow: every change is a **feature branch cut from `dev`** → a PR into `dev`, **squash-merged**
  → releases go **`dev` → `main` by PR** (a merge, not a squash). Never push to `dev` or `main` directly,
  and never base a feature branch on another feature branch: when work depends on an unmerged PR, wait
  for it to land, then rebase onto the new `dev` (`git rebase --onto origin/dev <old-base> <branch>`).
- A merged feature branch is deleted, on GitHub and locally; the repository deletes head branches on
  merge by default. Follow-up work starts a new branch from `dev`.
- The squash commit takes the **PR title**, so PR titles are Conventional Commits too. `main` is the
  release branch: release-please runs on pushes to `main`, and `v*` tags drive the desktop and
  OCI-stack release workflows.
- Commits are Conventional Commits (they feed release-please and `CHANGELOG.md`) and DCO signed-off
  (`git commit -s`); the DCO check runs on every PR.
- `pnpm-workspace.yaml` sets `minimumReleaseAge: 720`: a package version younger than 12 h fails
  `pnpm install --frozen-lockfile`. A fresh Dependabot PR failing only at install just needs a re-run.
- Dependency PRs that each touch `pnpm-lock.yaml` must be merged one at a time, each rebased onto the
  current `dev` first — GitHub merges the lockfile textually and can emit duplicate keys
  (`ERR_PNPM_BROKEN_LOCKFILE`) even while reporting the PR as clean.

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
  Tier C. Only a frame an attested site's own receiver heard, delivered by that site's own ingest (a TNC
  or MeshCom port), is first-party attested; an APRS-IS line whose q-construct names an attested site
  (`qAR,<site>`) stays Tier C, since anyone with a public passcode can inject it. A signed browser-bridge
  batch carries only the signer's own frames and is never attested. The `provenance` abstraction
  (transport enum + `firstPartyAttested` flag) is what the verify engine consumes — Tier A is gated on
  the flag, never on the transport.
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
gateway (`apps/`, `workers/gateway`, `servers/*`, `db/`, `tools/`) = **AGPL-3.0-or-later**;
reusable libraries (`packages/aprs`, `packages/ax25`, `packages/packet`, `packages/tools`,
`packages/shared`) = **MIT**; docs (`docs/`) = **CC-BY-SA-4.0**.
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
identity/auth (passkey + email, multiple base-call accounts), federation, schema (the
`0001_baseline.sql` domains plus any later migration), the API surface, web-app structure, licensing, and the deferred items in `TODO.md`.
Keep it dense and current; flag what is NOT done.
