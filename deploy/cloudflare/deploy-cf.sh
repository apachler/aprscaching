#!/usr/bin/env bash
set -euo pipefail
# Topology 4 one-shot: managed Cloudflare core (Worker + D1 + R2 + Pages). Requires wrangler + CF auth.
# API_BASE = the public URL the deployed Worker answers on (workers.dev or your custom domain) —
# it is baked into the SPA build as VITE_API_BASE, so the Pages site talks to YOUR gateway.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
API_BASE="${API_BASE:-}"
if [ -z "$API_BASE" ]; then
  read -rp ">> Public gateway URL for the SPA (e.g. https://api.example.net or https://aprscaching.<you>.workers.dev): " API_BASE
fi
cd "$ROOT/workers/gateway"
wrangler d1 create aprscaching || true
echo ">> Paste the database_id into wrangler.toml, then press Enter."; read -r _
wrangler d1 migrations apply aprscaching --remote
wrangler r2 bucket create aprscaching-media || true
wrangler secret put INGEST_SECRET
SOURCE_COMMIT="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
wrangler deploy --var SOURCE_COMMIT:"$SOURCE_COMMIT" --var SOURCE_BUILT_AT:"$(date +%s)" --var SOURCE_REPO:"${SOURCE_REPO:-https://github.com/apachler/aprscaching}"
# Build the SPA against the deployed gateway before publishing it — a stale/missing dist (it is
# gitignored) or a localhost VITE_API_BASE would ship a Pages site that talks to nothing.
( cd "$ROOT" && VITE_API_BASE="$API_BASE" pnpm --filter @aprscaching/web build )
cd "$ROOT" && wrangler pages deploy apps/web/dist --project-name aprscaching
echo ">> Done. Run the operator RF ingest with INGEST_URL=${API_BASE}/ingest (compose.ingest-only.yml)."
