# aprscaching — project map

The APRScaching-first web app, by OE8APR. This file is a map of the repository.

## Start here
- `README.md` — what the project is and how to run it (pnpm install, wrangler, ingest)
- `docs/` — the product manual (also served in-app): caching, the shack, operating an instance, the API
- `CLAUDE.md` — conventions and load-bearing invariants for working in this repo
- `TODO.md` — the short list of work intentionally deferred past 1.0

## Code
- `packages/aprs/` — pure APRS parser: TNC2, q-construct (RF vs injected), positions, MIC-E, weather, geo
- `packages/ax25/` — AX.25 connected-mode link (mod-8 and mod-128 / SREJ)
- `packages/packet/` — BBS + FBB forwarding, NET/ROM node, session server (pure protocol logic)
- `packages/tools/` — the signed tool-plugin system (manifest, capabilities, host, decoders)
- `packages/shared/` — zod contracts (Packet, WebSocket messages, DTOs) and the surface manifest
- `workers/gateway/` — the gateway: Worker + Durable Objects; `src/verify.ts` is the trust-tier engine;
  auth / callsign / federation / ingest / read-API modules; D1 + R2 bindings
- `servers/node/`, `servers/bun/` — the same gateway handler set on Node+SQLite and Bun+bun:sqlite
- `apps/ingest/` — the operator-local RF/APRS-IS ingest (KISS-over-TCP, IGate, digipeater, transports)
- `apps/web/` — the React + MapLibre single-page app
- `db/migrations/` — `0001_baseline.sql` (the full 1.0 schema); later changes add `NNNN_*.sql`

## tools/
- `tools/teaser/` — reproducible website teaser (seed → Playwright crawl → brand poster)
- `tools/smoke/`, `tools/dev/` — runtime conformance suites and the dev check/smoke scripts

## Trust model (the core idea)
Two orthogonal signals, neither of which blocks logging a find:
- Position tier: **A** = RF-corroborated · **B** = app-geolocation corroborated · **C** = IS-only
- Account: callsign control proven (passkey + an asynchronous control-verification badge)
