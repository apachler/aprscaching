# CLAUDE.md — aprscaching.com (reborn)

## Design rules (read before building/changing any UI)
@.claude/rules/ui-ux.md
@.claude/rules/css.md

## What this is
APRS-Caching-first web workbench. APRS Caching is the product; a full APRS workbench is the
platform. Greenfield (no legacy migration). Author/owner: OE8APR.

## IP
APRS Caching is the author's own work — build freely. Workbench capabilities are reimplemented
from OPEN specs (APRS101, APRS-IS, AX.25/KISS, Meshtastic, TAK/CoT). Never copy APRStac's
(KN4MKB) closed-source code/assets.

## Stack
pnpm monorepo. apps/web = React+MapLibre → Cloudflare Pages (aprscaching.com).
workers/gateway = Worker + Durable Objects + D1 + R2 (api.aprscaching.com).
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

Two backlog tracks fold into the milestones above (build each feature against its doc; both MUST
hold the ui-ux/css rules — progressive disclosure, opt-in raster, reduced-motion, the cost model):
- Adopted map & UX features — `docs/11-adopted-map-features.md`:
  M1 vector basemap + layer switcher · save/share view (URL state) · favorites + basic search;
  M2 topo/satellite layers · ruler+navigate · range rings + grid/MGRS · cache page (finds-over-time)
  · enriched search; M3 track history by date · time-replay · GPX/KML export · public read API;
  M4 deep-link/embeddable widget + QR · push alerts (nearby/new-cache/DNF) · API keys;
  M5 station telemetry/weather graphs · raw packet view (workbench).
- Sustainability & supporter donations — `docs/12-sustainability-donations.md` (free-in-full,
  recognition-only, never feature-gating): Now (no code) donation links + transparency page + the
  open-source LICENSE that unlocks the ARDC grant; M4 supporter badge + hide-nag + `/support`
  ledger; M5 peer cost-reimbursement (Open Collective). Monetization schema lands as a new migration
  (next free number), not the `0003` the doc names retrospectively.
