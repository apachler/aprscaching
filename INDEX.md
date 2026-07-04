# aprscaching.com — reborn · project bundle

Everything for the APRScaching-first web workbench, by OE8APR. Greenfield.

## Start here
- `README.md`      — what the scaffold is + quick start (pnpm install, wrangler, ingest)
- `CLAUDE.md`      — conventions for Claude Code (open `claude` here, then "implement M1")
- `PLAN.md`        — the committed product plan (APRScaching first; Tier B stack)
- `AUTH_AND_ANNOUNCE.md` — auth (passkey + callsign badge) and APRS-IS announce design

## Code (M0 scaffold — runs/extends from here)
- `packages/aprs/`     — pure parser: TNC2, q-construct (RF vs injected), position, geo (+tests)
- `packages/shared/`   — zod contracts (Packet, WS, DTOs)
- `workers/gateway/`   — Worker + Durable Object; `src/verify.ts` = trust-tier engine;
                         auth/callsign/announce/outbox modules; D1 + R2 bindings
- `apps/ingest/`       — APRS-IS client + batched forward + announce uplink (Fly/Pi)
- `apps/web/`          — React + MapLibre SPA (placeholder; real design = M1)
- `db/migrations/`     — `0001_baseline.sql` (the full 1.0 schema, squashed; post-1.0 adds `NNNN_*.sql`)

## docs/ — planning evolution (context/history)
- `01` web-app v1 → `02` cost-optimized → `03` feature-complete vs APRStac →
  `04` aprscaching reborn → `05` auth + announce → `06` federation + open network

## tools/
- `tools/teaser/` — reproducible website teaser (seed → Playwright crawl → brand poster)

## Trust model (the core idea)
Two orthogonal signals, neither blocks logging a find:
- Position tier: A = RF-corroborated · B = app-geo corroborated · C = IS-only
- Account: callsign control proven (passkey + async badge)

## Build order
M0 spine (here) → M1 caching core → M2 verification + geofencing → M3 import/heritage →
M4 community/gamify → M5 workbench depth → M6 headroom.
