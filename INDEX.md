# aprscaching — project map

The APRScaching-first web app, by OE8APR. This file is a map of the repository.

## Start here
- `README.md` — what the project is, the quick start and the licence
- `docs/` — the product manual (published at <https://apachler.github.io/aprscaching/>): caching, the Shack,
  operating an instance, the reference, design notes
- `CONTRIBUTING.md` — setup, the inner loop, commits and branches
- `CLAUDE.md` and `.claude/rules/` — conventions and load-bearing invariants for working in this repo
- `TODO.md` — the launch list and the work intentionally deferred past 1.0, with why each piece waits

## Code
- `packages/aprs/` — pure APRS parser: TNC2, q-construct (RF vs injected), positions, MIC-E, weather, geo,
  MeshCom ExtUDP
- `packages/ax25/` — AX.25 connected-mode link (mod-8 and mod-128 / SREJ)
- `packages/packet/` — BBS + FBB forwarding, NET/ROM node and INP3, session server (pure protocol logic)
- `packages/tools/` — the signed tool-plugin system (manifest, capabilities, host, decoders)
- `packages/shared/` — zod contracts (Packet, WebSocket messages, DTOs), the fedwire codec, the surface manifest
- `workers/gateway/` — the runtime-neutral gateway app (`src/app.ts` `handle()`); `src/verify.ts` is the trust-tier engine,
  `src/fedapply.ts` `admitFrame()` admits every signed federation frame
- `servers/node/`, `servers/bun/` — the same gateway on Node + SQLite and Bun + `bun:sqlite`
- `apps/ingest/` — the operator-local RF/APRS-IS ingest (KISS, AGWPE, host mode, MeshCom, Meshtastic, IGate,
  digipeater, NET/ROM node, AXUDP/AXIP)
- `apps/web/` — the React + MapLibre single-page app
- `db/migrations/` — `0001_baseline.sql` and the numbered files applied on top of it

## Deployment — `deploy/`
- `setup.sh` (writes a self-host `.env`), `docker-compose.yml` + `compose.home.yml` + `compose.ingest-only.yml`,
  `Dockerfile`, `Caddyfile`, `backup.sh`, `systemd/`
- `desktop/` (the Bun single binary), `pocket/` (a station on an Android phone), `cloudflare/` (CDN cache rules
  for Self-host behind Cloudflare), `oci/` (the Oracle Cloud stack)
- `scripts/build-oci-stack.sh` — builds the Oracle Cloud one-click stack archive

## tools/
- `tools/dev/` — `check.sh`, `smoke.sh`, `verify.sh`, the contributor inner loop
- `tools/smoke/`, `tools/conformance/`, `tools/e2e/` — runtime conformance suites, the MeshCom conformance run
  and the browser end-to-end test
- `tools/checks/` — CI guards (the OCI stack, dead exports, the documentation)
- `tools/interop/` — interoperability tests against reference packet software
- `tools/admin/`, `tools/fedkey/`, `tools/toolkey/`, `tools/licence/` — operator and signing command-line tools
- `tools/teaser/`, `tools/webauthn/` — screenshot and teaser tooling, and a WebAuthn test helper

## Trust model (the core idea)
Two orthogonal signals, neither of which blocks logging a find:
- Find tier: **A** = RF-corroborated · **B** = app-geolocation corroborated · **C** = IS-only
- Account: callsign control proven (on-air `VERIFY`, ampr.org DNS, LoTW certificate, or a sysop)
